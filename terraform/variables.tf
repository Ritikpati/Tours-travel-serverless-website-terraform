variable "region" {
  default = "us-east-1"
}
variable "prefix" {
  description = "Prefix for names that don't have to match the Lambda code"
  default     = "tf"
}
variable "zone_name" {
  default = "293131702654.realhandsonlabs.net "
}
variable "subdomain" {
  default = "ritiktourswebsite"
}
variable "upi_id" {
  default = "yourupi@bank"
}
variable "admin_password_hash" {
  description = "SHA-256 of the admin password (default is admin123)"
  default     = "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9"
}
variable "seed_packages" {
  description = "Add the sample packages on first apply"
  default     = true
}
variable "refund_5_9_percent" {
  description = "Refund % when cancelling 5 to 9 days before travel (10+ days = 80, 2-4 days = 10, 0-1 days = 0)"
  default     = 10
}
variable "payment_mode" {
  description = "simulation = test payment (no real gateway). Set to live only after a real gateway is integrated."
  default     = "simulation"
}
