# DSO303 Assignment 2 – Online Exam Platform on AWS

This repo has my architecture for moving a university's exams and assignment submissions online (8,000 students, about 400 staff).

![Architecture](architecture/architecture-diagram.png)

## Summary

The platform runs in ap-south-1 across two Availability Zones.

- Students reach the site through Route 53, AWS WAF and CloudFront. The frontend is a static site in S3.
- Users sign in with Cognito. Groups decide if someone is a student, tutor or admin.
- The API runs on ECS Fargate behind a load balancer, with tasks in both AZs.
- Exam data is in Aurora PostgreSQL (writer in AZ-A, reader in AZ-B). Autosaved answers go to DynamoDB every 30 seconds.
- Assignment files go straight from the browser to S3 with a presigned URL. Lifecycle rules keep them for 5 years.
- MCQ marking and results emails run in the background with SQS and Lambda. Tutors get an email through SNS when a student uploads.
- KMS encrypts the data, Secrets Manager holds the database password, and CloudWatch handles monitoring.
- GitHub Actions and CloudFormation deploy everything from code.

If one AZ fails, the other AZ keeps the platform running and Aurora fails over to the reader.

More detail:
- Walkthroughs: [architecture/walkthroughs.md](architecture/walkthroughs.md)
- Exam peak and AZ loss: [architecture/peak-and-az.md](architecture/peak-and-az.md)
- Service table: [docs/services.md](docs/services.md)
- Cloud Architecture Lab screenshots: [evidence/](evidence/)

## Deploy

You need an AWS account, the AWS CLI and a verified sender email in SES.

1. Create the GitHub deploy role:
   ```bash
   aws cloudformation deploy --region ap-south-1 --stack-name exam-github-oidc \
     --template-file infra/github-oidc.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubRepo=<owner>/<repo>
   aws cloudformation describe-stacks --region ap-south-1 --stack-name exam-github-oidc \
     --query "Stacks[0].Outputs[0].OutputValue" --output text
   ```
2. In the GitHub repo settings, add the secrets `AWS_DEPLOY_ROLE_ARN` (the ARN from step 1) and `ORIGIN_VERIFY_SECRET` (any random string), the variables `SENDER_EMAIL` and `ALARM_EMAIL`, and an environment called `production`.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and deploys everything. Every push after that redeploys automatically.
4. Run `app/schema.sql` once in the RDS Query Editor.
5. Add users in Cognito and put them in the `student`, `tutor` or `admin` group.

## Tear down

The databases and buckets are protected so they aren't deleted by accident. Turn that off first, then delete the stacks:

```bash
REGION=ap-south-1
# empty the buckets (repeat for the -web- and -trail- buckets)
aws s3api delete-objects --bucket exam-prod-assignments-<account-id> \
  --delete "$(aws s3api list-object-versions --bucket exam-prod-assignments-<account-id> \
  --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json)"
# turn off deletion protection
aws rds modify-db-cluster --region $REGION --db-cluster-identifier <cluster-id> --no-deletion-protection --apply-immediately
aws dynamodb update-table --region $REGION --table-name exam-prod-attempts --no-deletion-protection-enabled
# delete the stacks
aws cloudformation delete-stack --region $REGION --stack-name exam-prod
aws cloudformation delete-stack --region us-east-1 --stack-name exam-prod-waf
aws cloudformation delete-stack --region $REGION --stack-name exam-github-oidc
```

