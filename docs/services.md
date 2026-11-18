# Service documentation

Every service in the design, what it does, why I chose it, how it is set up and what it connects to. The settings match `infra/main.yaml`.

## Edge and frontend

| Service | Role | Why over an alternative | Configuration | Connects to |
|---|---|---|---|---|
| Route 53 | DNS for the exam website | Alias records point straight to CloudFront. The university's own DNS server could fail and can't point to AWS resources this way. | Public hosted zone, alias record to CloudFront | CloudFront |
| AWS WAF | Blocks attacks and floods before they reach the app | Managed rules need no servers. Running our own firewall on EC2 means more work and patching. | AWS managed rule sets (common attacks, bad inputs, bad IPs), rate limit 2,000 requests per 5 min per IP | CloudFront |
| CloudFront | CDN and the single HTTPS entry point | Caches the website close to students, so the exam rush doesn't hit our servers. Serving from the load balancer alone gives no caching. | Website files from S3 (cached), `/api/*` to the load balancer (not cached), HTTPS only, TLS 1.2+ | Route 53, WAF, S3 frontend, load balancer |
| ACM | TLS certificates | Free and renews itself. Manual certificates can expire in the middle of an exam. | Public certificate, DNS validated | CloudFront, load balancer |
| S3 (frontend) | Hosts the website files | Cheap and needs no servers. Running the site on EC2 would need patching and scaling. | Private bucket, only CloudFront can read it, versioning on | CloudFront |
| Cognito | Sign-in for students, tutors and admins | Gives login, passwords, MFA and tokens ready-made. Building our own login is risky. | User pool with groups `student`, `tutor`, `admin`; password at least 12 characters; tokens last 60 min | Browser, API |

## Network and compute

| Service | Role | Why over an alternative | Configuration | Connects to |
|---|---|---|---|---|
| VPC | Private network | Keeps the API and database off the internet. Two AZs let it survive losing one. | 10.0.0.0/16, six /19 subnets (public, app, data in each AZ), flow logs on | Everything inside it |
| Internet Gateway | Lets internet traffic reach the public subnets | Needed for the load balancer to receive requests | Attached to the VPC, used only by public subnets | Load balancer, NAT Gateways |
| NAT Gateway (×2) | Lets private tasks reach the internet without being reachable | One per AZ, so losing one AZ doesn't cut the other off. A single NAT would be a weak point. | One in each public subnet, each private subnet uses the NAT in its own AZ | Private app subnets |
| VPC endpoints (S3, DynamoDB) | Private, free path to S3 and DynamoDB | Autosave traffic skips the NAT Gateway, which saves money | Gateway endpoints on both private route tables | ECS API, S3, DynamoDB |
| Application Load Balancer | Spreads requests over the API tasks in both AZs | Health checks and HTTP routing that work with ECS. API Gateway + Lambda costs more at a steady 300–500 users. | In both public subnets, HTTPS, health check `/health` every 10 s, only accepts traffic from CloudFront | CloudFront, ECS API |
| ECS on Fargate | Runs the API containers | No servers to manage, unlike EC2. Scales in seconds. | 0.5 vCPU / 1 GB tasks; normally 4 tasks (2 per AZ); 12 tasks (6 per AZ) 30 min before an exam; scales up to 30 at 60% CPU | Load balancer, Aurora, DynamoDB, S3, SQS, Secrets Manager |
| ECR | Stores the API container image | Private and close to ECS. Docker Hub has rate limits. | Image scan on push, keeps the last 20 images | GitHub Actions, ECS |

## Data

| Service | Role | Why over an alternative | Configuration | Connects to |
|---|---|---|---|---|
| Aurora PostgreSQL | Main database: users, exams, questions, submissions, results | The data is relational and needs joins. Aurora fails over faster than normal RDS Multi-AZ (usually under 2 min). | Writer in AZ-A, reader in AZ-B (`db.r6g.large`), private subnets only, KMS encrypted, SSL forced, backups 35 days + point-in-time recovery | ECS API, Lambda, AWS Backup |
| RDS Proxy | Pools database connections | Many API tasks at peak could use up Aurora's connection limit. The proxy also holds connections during failover. | TLS required, credentials from Secrets Manager, in both data subnets | ECS API, Aurora |
| DynamoDB | Stores exam attempts and the 30-second autosaves | Handles about 100 writes per second with no planning and is spread over 3 AZs. Putting autosaves in Aurora would load the one writer. | Table `ExamAttempts`, on-demand capacity, point-in-time recovery, KMS encrypted | ECS API, marking Lambda, AWS Backup |
| S3 (assignments) | Stores assignment files (PDF/ZIP up to 50 MB) | Cheaper and more durable than EBS. Presigned links keep big uploads off the API. | Private, KMS encrypted, versioning on, HTTPS only; Standard-IA after 90 days, Glacier after 365 days, deleted after 1,825 days (5 years) | Browser, ECS API, EventBridge, Lambda |

## Background processing

| Service | Role | Why over an alternative | Configuration | Connects to |
|---|---|---|---|---|
| SQS | Queues marking jobs and results emails | Thousands of submissions at once just wait in the queue. Marking inside the request would slow students down. | Two queues (marking, results email), KMS encrypted, failed messages go to a dead-letter queue after 3 tries | ECS API, Lambda |
| Lambda | Marks MCQs, processes uploads, sends results emails | Pay per job and scales by itself. Always-on servers would sit idle most of the year. | Python 3.12, 256–512 MB, 30–60 s timeout, marking limited to 50 at once | SQS, EventBridge, S3, DynamoDB, Aurora, SNS, SES |
| EventBridge | Starts the upload Lambda when a file arrives | Can filter by folder and add more targets later. Plain S3 notifications are more limited. | Rule on "Object Created" in `submissions/`, retries for 24 h | S3, Lambda |
| SNS | Emails the tutor when a student uploads | One message reaches every subscribed tutor, and SNS retries by itself. SES needs more setup for a simple alert. | Topic `tutor-notifications`, email subscription, KMS encrypted | Upload Lambda, tutor email |
| SES | Sends "results released" emails to students | Built for sending to thousands of people. SNS would make all 8,000 students confirm a subscription. | Verified domain with DKIM and SPF | Results Lambda |

## Security, monitoring and deployment

| Service | Role | Why over an alternative | Configuration | Connects to |
|---|---|---|---|---|
| KMS | Encryption keys for data at rest | Our own key logs every use and rotates. AWS-owned keys give no control. | One customer key, yearly rotation | S3, Aurora, DynamoDB, SQS, backups |
| Secrets Manager | Stores the database password | Rotates the password and keeps it out of the code. Environment variables don't rotate. | Aurora password created and rotated by RDS | ECS API, Lambda, RDS Proxy |
| IAM | Permissions | Each part gets its own role with only what it needs. Shared keys are risky. | One role per service, no long-lived access keys | Every service |
| CloudWatch | Logs, metrics and alarms | Built into every AWS service, nothing extra to run | Logs kept 90 days; alarms on errors, slow responses, high CPU and failed messages; exam-day dashboard | All services |
| CloudTrail | Audit log of every AWS action | Shows who changed what over 5 years | All regions, log validation on, logs kept 5 years | S3 |
| AWS Backup | Backups kept for 5 years | One plan covers Aurora and DynamoDB instead of separate scripts | Daily backups kept 35 days, monthly backups kept 5 years, encrypted vault | Aurora, DynamoDB |
| CloudFormation | Builds the whole platform from code | Native to AWS and rolls back if a deploy fails. Building by hand in the console can't be repeated. | Stacks `exam-prod-waf` (us-east-1) and `exam-prod` (ap-south-1), templates in `infra/` | All services |
| GitHub Actions | CI/CD pipeline | The code is already on GitHub and it's free for students. CodePipeline is one more service to set up. | `.github/workflows/deploy.yml`: checks the code on every push to `main`, then builds the image and deploys the stacks | GitHub, ECR, CloudFormation, S3, CloudFront |