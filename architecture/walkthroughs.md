# Request walkthroughs

Diagram: [`architecture-diagram.png`](architecture-diagram.png). I built it in the Cloud Architecture Lab.
Region: **ap-south-1 (Mumbai)**, the closest AWS region to the university. Two Availability Zones: **AZ-a** and **AZ-b**.

## Network layout

| Subnet | AZ-a | AZ-b | What lives there |
|---|---|---|---|
| Public | 10.0.0.0/19 | 10.0.32.0/19 | ALB nodes, NAT Gateway (one per AZ) |
| Private app | 10.0.64.0/19 | 10.0.96.0/19 | ECS Fargate API tasks |
| Private data | 10.0.128.0/19 | 10.0.160.0/19 | Aurora PostgreSQL writer / reader |

Each subnet is a /19 with 8,187 usable addresses. Each Fargate task takes one IP, so that is plenty. It also matches how the Cloud Architecture Lab splits a /16 VPC into six equal subnets. The range 10.0.192.0/18 stays free for growth.

The security groups form a chain. `ALB-SG` accepts 443 only from the CloudFront managed prefix list. `API-SG` accepts 8080 only from `ALB-SG`. `DB-SG` accepts 5432 only from `API-SG`. The database has no public IP and no route to the Internet Gateway.

---

## Walkthrough 1: a student opens an exam and answers autosave

```mermaid
sequenceDiagram
    autonumber
    participant B as Student browser
    participant R53 as Route 53
    participant CF as CloudFront + WAF
    participant S3W as S3 (SPA)
    participant COG as Cognito
    participant ALB as ALB (2 AZs)
    participant API as Fargate API (AZ-a or AZ-b)
    participant DB as Aurora PostgreSQL
    participant DDB as DynamoDB (autosave)
    participant Q as SQS marking
    participant L as Lambda auto-mark

    B->>R53: exams.uni.edu ?
    R53-->>B: CloudFront alias
    B->>CF: GET / (HTTPS)
    CF->>S3W: cache miss only (OAC)
    CF-->>B: React app (cached at edge)
    B->>COG: sign in (SRP)
    COG-->>B: ID/access JWT, group = student
    B->>CF: GET /api/v1/exams/123  (Bearer JWT)
    CF->>ALB: WAF rules + rate limit passed
    ALB->>API: healthy target in either AZ
    API->>API: verify JWT signature, group = student, exam window open
    API->>DB: SELECT exam, questions (no answer key)
    API->>DDB: PutItem attempt {student, exam, startedAt, deadline}
    API-->>B: questions + server deadline
    loop every 30 seconds
        B->>CF: PUT /api/v1/attempts/123/answers {seq, answers}
        CF->>ALB: forward
        ALB->>API: forward
        API->>DDB: conditional UpdateItem (only if seq is newer, before deadline)
        API-->>B: 200 saved at 10:31:30
    end
    B->>CF: POST /api/v1/attempts/123/submit
    API->>DDB: mark attempt SUBMITTED
    API->>Q: SendMessage {attemptId}
    API-->>B: 202 submitted
    Q->>L: batch of messages
    L->>DDB: read final answers + MCQ key copied at exam start
    L->>DDB: write mcqScore, status MARKED_MCQ (short answers wait for tutor)
```

Step by step:
1. **DNS and edge.** Route 53 points the domain to CloudFront. WAF checks the AWS managed rules and a per-IP rate limit. CloudFront serves the SPA from its cache. On a miss, it reads the private S3 bucket through Origin Access Control.
2. **Sign-in.** Cognito signs the student in and issues a JWT. Its `cognito:groups` claim is `student`.
3. **Open exam.** `GET /api/v1/exams/123` goes CloudFront → ALB → any healthy Fargate task in AZ-a or AZ-b. The API checks the JWT, checks that the student is enrolled and that the exam window is open, then reads the exam from Aurora without the answer key. It records the attempt start in DynamoDB, together with a copy of the MCQ answer key. That way marking never has to query Aurora at peak time. The **server** sets the deadline, so nobody can cheat the timer from the browser.
4. **Autosave every 30 s.** The browser sends the current answers with a sequence number that keeps going up. The API runs a conditional `UpdateItem` in DynamoDB, so an older or late save can never overwrite a newer one. The browser also keeps a copy in local storage, so a network blip loses nothing.
5. **Submit and auto-mark.** On submit, or when the timer runs out, the API sets the status to `SUBMITTED` and puts a message on SQS. A Lambda function marks the MCQs against the stored key and writes the score on the attempt. When the tutor finishes marking the short answers, the API saves the final result to the `results` table in Aurora. A message that fails 3 times goes to a dead-letter queue.

## Walkthrough 2: a student uploads a 40 MB assignment and the tutor is notified

```mermaid
sequenceDiagram
    autonumber
    participant B as Student browser
    participant CF as CloudFront + WAF
    participant API as Fargate API
    participant S3 as S3 assignments (SSE-KMS)
    participant EB as EventBridge
    participant LU as Lambda upload processor
    participant DB as Aurora
    participant SNS as SNS tutor-notifications
    participant T as Tutor inbox

    B->>CF: POST /api/v1/assignments/77/uploads {name, type, size=40MB}
    CF->>API: via ALB
    API->>API: JWT ok, before due date, type PDF/ZIP, size <= 50 MB
    API-->>B: presigned PUT URL (expires 15 min, fixed key + content-type)
    B->>S3: PUT 40 MB directly (HTTPS, never touches the API)
    S3->>S3: encrypt with KMS key, keep version
    S3->>EB: Object Created event
    EB->>LU: rule matches prefix submissions/
    LU->>S3: HEAD object (check size, type)
    LU->>DB: INSERT submission row via RDS Data API
    LU->>SNS: Publish "New submission from Student X"
    SNS->>T: email (tutor's address is subscribed to the topic)
```

Step by step:
1. **Ask for an upload slot.** The browser calls `POST /api/v1/assignments/77/uploads`. The API checks the JWT, the due date, the file type (PDF or ZIP) and the size (≤ 50 MB). It returns a **presigned S3 PUT URL**. The URL works for 15 minutes and only for one object key and content type.
2. **Direct upload.** The browser PUTs the 40 MB file straight to S3 over HTTPS. The file never passes through CloudFront, the ALB or the containers, so big uploads can't tie up the API during exam week.
3. **Stored safely.** S3 encrypts the object with the KMS key and keeps every version. Lifecycle rules move it to cheaper storage over time and delete it after 5 years.
4. **Event-driven processing.** S3 sends an *Object Created* event to EventBridge. A rule triggers the upload-processor Lambda. The Lambda checks the object and writes a submission row in Aurora.
5. **Tutor notified.** The Lambda publishes a message to the **SNS topic `tutor-notifications`**. The tutor's email address subscribes to the topic, so SNS emails them straight away. SNS retries delivery itself, so this small, one-per-upload message needs no extra queue.

**Results released (the other email feature).** When a tutor releases results, the API puts one message per student on the **SQS results-email queue**. A Lambda sends each email through **Amazon SES**. I use SQS here because one release can create hundreds of emails at once. The queue absorbs the burst and retries any failures through a DLQ.
