use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

pub const DEFAULT_TOLERANCE_MS: i64 = 300_000; // 5 minutes

#[derive(Debug)]
pub struct VerificationResult {
    pub valid: bool,
    pub error: Option<String>,
}

impl VerificationResult {
    fn ok() -> Self {
        Self {
            valid: true,
            error: None,
        }
    }

    fn fail(message: impl Into<String>) -> Self {
        Self {
            valid: false,
            error: Some(message.into()),
        }
    }

    pub fn is_valid(&self) -> bool {
        self.valid
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

struct ParsedHeader {
    timestamp: i64,
    nonce: Option<String>,
    hmac_signature: Option<String>,
    ed25519_signature: Option<String>,
}

/// Verifies Stellar Alerts webhook signatures.
///
/// Mirrors `apps/api/src/utils/webhook-signer.ts`'s header format exactly:
/// `t=<unix_ms>[,n=<nonce>],v1=<hex_hmac_sha256>` (and, for Ed25519-signed
/// webhooks, `v2=<hex_ed25519_signature>` alongside or instead of `v1`).
/// The signed payload is `{timestamp}.{nonce}.{body}` when a nonce is
/// present, or `{timestamp}.{body}` otherwise — see `buildWebhookDataToSign`
/// in the TypeScript signer.
pub struct WebhookVerifier {
    secret: Option<String>,
    verifying_key: Option<VerifyingKey>,
    tolerance_ms: i64,
    seen_nonces: Arc<Mutex<HashSet<String>>>,
}

impl WebhookVerifier {
    /// Verifier for HMAC-SHA256-signed webhooks (the default scheme).
    pub fn new_hmac(secret: &str, tolerance_ms: i64) -> Self {
        Self {
            secret: Some(secret.to_string()),
            verifying_key: None,
            tolerance_ms,
            seen_nonces: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Verifier for Ed25519-signed webhooks. `public_key` is the 32-byte
    /// Ed25519 public key.
    pub fn new_ed25519(public_key: &[u8; 32], tolerance_ms: i64) -> Result<Self, String> {
        let verifying_key = VerifyingKey::from_bytes(public_key)
            .map_err(|e| format!("Invalid Ed25519 public key: {e}"))?;
        Ok(Self {
            secret: None,
            verifying_key: Some(verifying_key),
            tolerance_ms,
            seen_nonces: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub fn verify(&self, payload: &[u8], signature_header: &str) -> VerificationResult {
        let parsed = match Self::parse_signature_header(signature_header) {
            Ok(p) => p,
            Err(e) => return VerificationResult::fail(e),
        };

        let current_timestamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as i64,
            Err(_) => return VerificationResult::fail("Failed to get current timestamp"),
        };

        if (current_timestamp - parsed.timestamp).abs() > self.tolerance_ms {
            return VerificationResult::fail(format!(
                "Timestamp drift exceeds tolerance: {}ms > {}ms",
                (current_timestamp - parsed.timestamp).abs(),
                self.tolerance_ms
            ));
        }

        if let Some(nonce) = &parsed.nonce {
            let mut nonces = self.seen_nonces.lock().unwrap();
            if nonces.contains(nonce) {
                return VerificationResult::fail("Replay attack detected: nonce already used");
            }
            nonces.insert(nonce.clone());
        }

        let signing_payload =
            Self::build_data_to_sign(payload, parsed.timestamp, parsed.nonce.as_deref());

        if let Some(secret) = &self.secret {
            let Some(hex_sig) = &parsed.hmac_signature else {
                return VerificationResult::fail("Missing v1 (HMAC) signature in header");
            };
            return Self::verify_hmac(secret, &signing_payload, hex_sig);
        }

        if let Some(verifying_key) = &self.verifying_key {
            let Some(hex_sig) = &parsed.ed25519_signature else {
                return VerificationResult::fail("Missing v2 (Ed25519) signature in header");
            };
            return Self::verify_ed25519(verifying_key, &signing_payload, hex_sig);
        }

        VerificationResult::fail("Verifier has neither an HMAC secret nor an Ed25519 key")
    }

    fn verify_hmac(
        secret: &str,
        signing_payload: &[u8],
        hex_signature: &str,
    ) -> VerificationResult {
        let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
            Ok(m) => m,
            Err(_) => return VerificationResult::fail("Invalid HMAC key length"),
        };
        mac.update(signing_payload);
        let expected = mac.finalize().into_bytes();
        let expected_hex = hex::encode(expected);

        // Constant-time comparison over the raw bytes, not the hex strings,
        // so timing does not leak how many leading hex characters matched.
        let Ok(given_bytes) = hex::decode(hex_signature) else {
            return VerificationResult::fail("Signature is not valid hex");
        };
        if given_bytes.len() != expected.len() || given_bytes.ct_eq(&expected).unwrap_u8() != 1 {
            return VerificationResult::fail(format!(
                "Invalid HMAC signature (expected {expected_hex})"
            ));
        }
        VerificationResult::ok()
    }

    fn verify_ed25519(
        verifying_key: &VerifyingKey,
        signing_payload: &[u8],
        hex_signature: &str,
    ) -> VerificationResult {
        let Ok(sig_bytes) = hex::decode(hex_signature) else {
            return VerificationResult::fail("Signature is not valid hex");
        };
        let Ok(sig_array): Result<[u8; 64], _> = sig_bytes.try_into() else {
            return VerificationResult::fail("Ed25519 signature must be 64 bytes");
        };
        let signature = Signature::from_bytes(&sig_array);
        match verifying_key.verify(signing_payload, &signature) {
            Ok(()) => VerificationResult::ok(),
            // ed25519-dalek's verification is already constant-time; no
            // extra comparison step is needed here.
            Err(_) => VerificationResult::fail("Invalid Ed25519 signature"),
        }
    }

    fn build_data_to_sign(payload: &[u8], timestamp: i64, nonce: Option<&str>) -> Vec<u8> {
        let payload_str = String::from_utf8_lossy(payload);
        let signed = match nonce {
            Some(n) => format!("{timestamp}.{n}.{payload_str}"),
            None => format!("{timestamp}.{payload_str}"),
        };
        signed.into_bytes()
    }

    fn parse_signature_header(header: &str) -> Result<ParsedHeader, String> {
        let mut timestamp: Option<i64> = None;
        let mut nonce: Option<String> = None;
        let mut hmac_signature: Option<String> = None;
        let mut ed25519_signature: Option<String> = None;

        for part in header.split(',') {
            let part = part.trim();
            if let Some(rest) = part.strip_prefix("t=") {
                timestamp = Some(
                    rest.parse::<i64>()
                        .map_err(|_| "Invalid timestamp".to_string())?,
                );
            } else if let Some(rest) = part.strip_prefix("n=") {
                nonce = Some(rest.to_string());
            } else if let Some(rest) = part.strip_prefix("v1=") {
                hmac_signature = Some(rest.to_string());
            } else if let Some(rest) = part.strip_prefix("v2=") {
                ed25519_signature = Some(rest.to_string());
            }
        }

        let timestamp = timestamp.ok_or("Missing t= timestamp in signature header")?;
        if hmac_signature.is_none() && ed25519_signature.is_none() {
            return Err("Signature header has neither v1 nor v2".to_string());
        }

        Ok(ParsedHeader {
            timestamp,
            nonce,
            hmac_signature,
            ed25519_signature,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn hmac_header(secret: &str, timestamp: i64, nonce: Option<&str>, payload: &[u8]) -> String {
        let signing_payload = WebhookVerifier::build_data_to_sign(payload, timestamp, nonce);
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(&signing_payload);
        let sig = hex::encode(mac.finalize().into_bytes());
        match nonce {
            Some(n) => format!("t={timestamp},n={n},v1={sig}"),
            None => format!("t={timestamp},v1={sig}"),
        }
    }

    #[test]
    fn verifies_a_valid_hmac_signature_with_nonce() {
        let verifier = WebhookVerifier::new_hmac("test_secret", DEFAULT_TOLERANCE_MS);
        let payload = b"{\"event\":\"payment.received\"}";
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let header = hmac_header("test_secret", ts, Some("nonce-1"), payload);

        let result = verifier.verify(payload, &header);
        assert!(result.is_valid(), "{:?}", result.error());
    }

    #[test]
    fn verifies_a_valid_hmac_signature_without_nonce() {
        let verifier = WebhookVerifier::new_hmac("test_secret", DEFAULT_TOLERANCE_MS);
        let payload = b"{\"event\":\"payment.received\"}";
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let header = hmac_header("test_secret", ts, None, payload);

        let result = verifier.verify(payload, &header);
        assert!(result.is_valid(), "{:?}", result.error());
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let verifier = WebhookVerifier::new_hmac("test_secret", DEFAULT_TOLERANCE_MS);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let header = hmac_header("test_secret", ts, Some("nonce-1"), b"original payload");

        let result = verifier.verify(b"tampered payload", &header);
        assert!(!result.is_valid());
    }

    #[test]
    fn rejects_a_signature_from_the_wrong_secret() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let header = hmac_header("wrong_secret", ts, Some("nonce-1"), b"payload");

        let verifier = WebhookVerifier::new_hmac("test_secret", DEFAULT_TOLERANCE_MS);
        let result = verifier.verify(b"payload", &header);
        assert!(!result.is_valid());
    }

    #[test]
    fn rejects_a_timestamp_outside_tolerance() {
        let verifier = WebhookVerifier::new_hmac("test_secret", 1_000);
        let payload = b"payload";
        let stale_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
            - 60_000;
        let header = hmac_header("test_secret", stale_ts, Some("nonce-1"), payload);

        let result = verifier.verify(payload, &header);
        assert!(!result.is_valid());
        assert!(result.error().unwrap().contains("tolerance"));
    }

    #[test]
    fn rejects_a_replayed_nonce() {
        let verifier = WebhookVerifier::new_hmac("test_secret", DEFAULT_TOLERANCE_MS);
        let payload = b"payload";
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let header = hmac_header("test_secret", ts, Some("nonce-1"), payload);

        let first = verifier.verify(payload, &header);
        assert!(first.is_valid());

        let second = verifier.verify(payload, &header);
        assert!(!second.is_valid());
        assert!(second.error().unwrap().contains("Replay"));
    }

    #[test]
    fn verifies_a_valid_ed25519_signature() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();

        let payload = b"{\"event\":\"soroban.contract_event\"}";
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let signing_payload = WebhookVerifier::build_data_to_sign(payload, ts, Some("nonce-2"));

        use ed25519_dalek::Signer;
        let signature = signing_key.sign(&signing_payload);
        let header = format!("t={ts},n=nonce-2,v2={}", hex::encode(signature.to_bytes()));

        let verifier =
            WebhookVerifier::new_ed25519(&verifying_key.to_bytes(), DEFAULT_TOLERANCE_MS).unwrap();
        let result = verifier.verify(payload, &header);
        assert!(result.is_valid(), "{:?}", result.error());
    }

    #[test]
    fn rejects_an_ed25519_signature_from_the_wrong_key() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let other_key = SigningKey::generate(&mut csprng);

        let payload = b"payload";
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let signing_payload = WebhookVerifier::build_data_to_sign(payload, ts, None);

        use ed25519_dalek::Signer;
        let signature = signing_key.sign(&signing_payload);
        let header = format!("t={ts},v2={}", hex::encode(signature.to_bytes()));

        let verifier = WebhookVerifier::new_ed25519(
            &other_key.verifying_key().to_bytes(),
            DEFAULT_TOLERANCE_MS,
        )
        .unwrap();
        let result = verifier.verify(payload, &header);
        assert!(!result.is_valid());
    }

    #[test]
    fn rejects_a_header_missing_any_signature_field() {
        let verifier = WebhookVerifier::new_hmac("test_secret", DEFAULT_TOLERANCE_MS);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let result = verifier.verify(b"payload", &format!("t={ts}"));
        assert!(!result.is_valid());
    }
}
