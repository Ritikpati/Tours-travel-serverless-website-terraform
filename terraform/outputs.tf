output "user_api_url" {
  value = aws_apigatewayv2_api.api["user"].api_endpoint
}
output "admin_api_url" {
  value = aws_apigatewayv2_api.api["admin"].api_endpoint
}
output "user_bucket" {
  value = aws_s3_bucket.user.id
}
output "admin_bucket" {
  value = aws_s3_bucket.admin.id
}
output "user_url" {
  value = "http://${local.user_bucket}"
}
output "admin_url" {
  value = "https://${aws_cloudfront_distribution.admin.domain_name}"
}
