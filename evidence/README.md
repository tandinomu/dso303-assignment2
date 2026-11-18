# Evidence: Cloud Architecture Lab

All screenshots come from the cs-Sensei Cloud Architecture Lab (v1.0.0).

## Screenshots

| File | What it shows | Result in the Lab |
|---|---|---|
| `architecture-diagram.png` | Full design: two AZs and all tiers (the same image is in `architecture/`) | Design |
| `walkthrough-1-exam.png` | Path: Student → Route 53 → WAF → CloudFront → Internet Gateway → Load Balancer → ECS API (AZ-A) → DynamoDB → Aurora writer (A); 17 steps | HTTP 200 in 209 ms |
| `walkthrough-1-exam-1.png` | Trace steps 1–7: DNS, WAF inspection, CloudFront, Internet Gateway | SUCCESS |
| `walkthrough-1-exam-2.png` | Trace steps 8–14: route table, Load Balancer picks a healthy ECS target, DynamoDB call, IAM ALLOW `dynamodb:PutItem` | SUCCESS |
| `walkthrough-1-exam-3.png` | Trace steps 13–17: SQL to Aurora writer, HTTP 200, SUCCESS summary | SUCCESS |
| `walkthrough-2-upload.png` | Path: Student (upload) → S3 assignments (direct, no ALB/ECS) → EventBridge → Lambda upload → SNS tutor email; 7 steps | HTTP 200 in 110 ms |
| `walkthrough-2-upload-1.png` | Trace steps 1–6: S3 ObjectCreated event, EventBridge, Lambda, IAM ALLOW `sns:Publish`, SNS publish accepted | SUCCESS |
| `walkthrough-2-upload-2.png` | Trace steps 4–7 and the SUCCESS summary | SUCCESS |
| `az-a-failover.png` | AZ-A outage: the request goes to ECS API (AZ-B), with "Multi-AZ Automated Database Failover"; 16 steps | HTTP 200 |
| `az-b-failover.png` | AZ-B outage: the request is served through AZ-A; 17 steps | HTTP 200 |
| `az-b-failover-1.png` | Trace step 10: "1 FAILED target(s) (ECS API (AZ-B))", and the system stays up | HTTP 200 |

## What the evidence proves

| Requirement | Evidence |
|---|---|
| Two-AZ design, every component in the right tier | `architecture-diagram.png` |
| Walkthrough 1 works end to end | `walkthrough-1-exam*.png` |
| Walkthrough 2 works: the upload bypasses the API and the tutor is notified | `walkthrough-2-upload*.png` |
| Survives the loss of either AZ, including database failover | `az-a-failover.png`, `az-b-failover*.png` |

## Notes on simulator scope
- RDS Proxy is an operation-only resource in this Lab, so it can't sit on a request path. The SQL hop goes from ECS straight to Aurora. The proxy is linked to the Aurora writer and Secrets Manager in its settings.
- To keep the diagram simple, only the main flows are drawn as lines. How the API feeds the marking and results-email queues, and which NAT Gateway each AZ uses, is written in each component's description and in architecture/walkthroughs.md.
