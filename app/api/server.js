// Exam platform API (runs on ECS Fargate behind the ALB). Implements the two walkthroughs.
import express from "express";
import pg from "pg";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const env = process.env;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sqs = new SQSClient({});
const secret = env.DB_SECRET ? JSON.parse(env.DB_SECRET) : {};
const db = new pg.Pool({
  host: env.DB_HOST, database: env.DB_NAME, user: secret.username, password: secret.password,
  ssl: { rejectUnauthorized: false }, max: 10, // RDS Proxy does the real pooling
});
const verifier = env.USER_POOL_ID
  ? CognitoJwtVerifier.create({ userPoolId: env.USER_POOL_ID, tokenUse: "access", clientId: env.USER_POOL_CLIENT_ID })
  : null;

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, az: env.AWS_AZ || "unknown" }));

// --- auth: verify Cognito JWT and role (student / tutor / admin)
const requireRole = (...roles) => async (req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const claims = await verifier.verify(token);
    const groups = claims["cognito:groups"] || [];
    if (!roles.some((r) => groups.includes(r))) return res.status(403).json({ error: "forbidden" });
    req.user = { id: claims.sub, groups };
    next();
  } catch {
    res.status(401).json({ error: "unauthorised" });
  }
};

// --- Walkthrough 1: open exam
app.get("/api/v1/exams/:examId", requireRole("student"), async (req, res) => {
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.opens_at, e.closes_at, e.duration_min,
            json_agg(json_build_object('id', q.id, 'type', q.type, 'text', q.text, 'options', q.options)) AS questions
       FROM exams e JOIN questions q ON q.exam_id = e.id
       JOIN enrolments en ON en.course_id = e.course_id AND en.student_id = $2
      WHERE e.id = $1 AND now() BETWEEN e.opens_at AND e.closes_at
      GROUP BY e.id`, [req.params.examId, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "exam not open" });
  const exam = rows[0];
  const key = await db.query(`SELECT id, correct FROM questions WHERE exam_id = $1 AND type = 'MCQ'`, [exam.id]);
  const attemptId = `${exam.id}#${req.user.id}`;
  const deadline = Date.now() + exam.duration_min * 60_000;            // server-side timer
  await ddb.send(new PutCommand({
    TableName: env.TABLE,
    Item: { attemptId, examId: exam.id, studentId: req.user.id, status: "IN_PROGRESS", seq: 0,
            answers: {}, deadline, answerKey: Object.fromEntries(key.rows.map((r) => [r.id, r.correct])) },
    ConditionExpression: "attribute_not_exists(attemptId)",            // re-opening keeps saved answers
  })).catch((e) => { if (e.name !== "ConditionalCheckFailedException") throw e; });
  const saved = await ddb.send(new GetCommand({ TableName: env.TABLE, Key: { attemptId } }));
  res.json({ attemptId, exam: { ...exam }, deadline: saved.Item.deadline, answers: saved.Item.answers });
});

// --- Walkthrough 1: autosave every 30 s (newer seq wins, rejected after deadline)
app.put("/api/v1/attempts/:attemptId/answers", requireRole("student"), async (req, res) => {
  const { seq, answers } = req.body;
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.TABLE, Key: { attemptId: req.params.attemptId },
      UpdateExpression: "SET answers = :a, seq = :s, savedAt = :t",
      ConditionExpression: "studentId = :u AND #st = :p AND seq < :s AND deadline > :t",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":a": answers, ":s": seq, ":t": Date.now(), ":u": req.user.id, ":p": "IN_PROGRESS" },
    }));
    res.json({ saved: true, at: new Date().toISOString() });
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return res.status(409).json({ saved: false });
    throw e;
  }
});

// --- Walkthrough 1: submit -> SQS -> auto-mark Lambda
app.post("/api/v1/attempts/:attemptId/submit", requireRole("student"), async (req, res) => {
  await ddb.send(new UpdateCommand({
    TableName: env.TABLE, Key: { attemptId: req.params.attemptId },
    UpdateExpression: "SET #st = :s, submittedAt = :t",
    ConditionExpression: "studentId = :u",
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: { ":s": "SUBMITTED", ":t": Date.now(), ":u": req.user.id },
  }));
  await sqs.send(new SendMessageCommand({ QueueUrl: env.MARKING_QUEUE,
    MessageBody: JSON.stringify({ attemptId: req.params.attemptId }) }));
  res.status(202).json({ status: "SUBMITTED" });
});

// --- Walkthrough 2: presigned upload URL (file goes browser -> S3 directly)
const ALLOWED = { "application/pdf": ".pdf", "application/zip": ".zip" };
app.post("/api/v1/assignments/:assignmentId/uploads", requireRole("student"), async (req, res) => {
  const { fileName, contentType, size } = req.body;
  if (!ALLOWED[contentType] || !fileName?.toLowerCase().endsWith(ALLOWED[contentType]))
    return res.status(400).json({ error: "PDF or ZIP only" });
  if (!(size > 0 && size <= 50 * 1024 * 1024)) return res.status(400).json({ error: "max 50 MB" });
  const { rows } = await db.query(`SELECT 1 FROM assignments WHERE id = $1 AND due_at > now()`, [req.params.assignmentId]);
  if (!rows.length) return res.status(403).json({ error: "closed" });
  const key = `submissions/${req.params.assignmentId}/${req.user.id}/${Date.now()}-${fileName.replace(/[^\w.-]/g, "_")}`;
  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: env.BUCKET, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: 900 });
  res.json({ uploadUrl: url, key, expiresInSeconds: 900 });
});

// --- tutor releases results -> one email message per student on the notify queue
app.post("/api/v1/exams/:examId/release", requireRole("tutor", "admin"), async (req, res) => {
  const { rows } = await db.query(
    `UPDATE exams SET results_released = true WHERE id = $1 RETURNING
       (SELECT json_agg(u.email) FROM enrolments en JOIN users u ON u.id = en.student_id
         WHERE en.course_id = exams.course_id) AS emails`, [req.params.examId]);
  for (const email of rows[0]?.emails || [])
    await sqs.send(new SendMessageCommand({ QueueUrl: env.NOTIFY_QUEUE,
      MessageBody: JSON.stringify({ type: "RESULTS_RELEASED", email }) }));
  res.json({ released: true });
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "internal" }); });
app.listen(env.PORT || 8080, () => console.log("api listening"));
