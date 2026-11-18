-- Aurora PostgreSQL schema (run once, e.g. with the RDS Query Editor / Data API)
CREATE TABLE users       (id text PRIMARY KEY, email text NOT NULL UNIQUE, role text NOT NULL CHECK (role IN ('student','tutor','admin')));
CREATE TABLE courses     (id text PRIMARY KEY, title text NOT NULL, tutor_id text REFERENCES users(id));
CREATE TABLE enrolments  (course_id text REFERENCES courses(id), student_id text REFERENCES users(id), PRIMARY KEY (course_id, student_id));
CREATE TABLE exams       (id text PRIMARY KEY, course_id text REFERENCES courses(id), title text NOT NULL,
                          opens_at timestamptz NOT NULL, closes_at timestamptz NOT NULL, duration_min int NOT NULL,
                          results_released boolean NOT NULL DEFAULT false);
CREATE TABLE questions   (id text PRIMARY KEY, exam_id text REFERENCES exams(id), type text CHECK (type IN ('MCQ','SHORT')),
                          text text NOT NULL, options jsonb, correct text);
CREATE TABLE results     (exam_id text REFERENCES exams(id), student_id text REFERENCES users(id),
                          mcq_score int, short_score int, marked_by text, PRIMARY KEY (exam_id, student_id));
CREATE TABLE assignments (id text PRIMARY KEY, course_id text REFERENCES courses(id), tutor_id text REFERENCES users(id),
                          title text NOT NULL, due_at timestamptz NOT NULL);
CREATE TABLE submissions (id bigserial PRIMARY KEY, assignment_id text REFERENCES assignments(id),
                          student_id text REFERENCES users(id), s3_key text NOT NULL, version_id text,
                          bytes bigint, valid boolean, uploaded_at timestamptz NOT NULL DEFAULT now());
