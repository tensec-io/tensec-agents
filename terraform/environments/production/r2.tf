# =============================================================================
# Cloudflare R2 Buckets
# =============================================================================

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-media-${local.name_suffix}"
  location   = var.r2_media_location
}

resource "cloudflare_r2_bucket" "session_attachments" {
  account_id = var.cloudflare_account_id
  name       = "session-attachments"
  location   = "WNAM"
}
