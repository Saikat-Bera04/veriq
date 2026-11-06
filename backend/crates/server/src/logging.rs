//! Redaction helpers for values that may originate in configuration or an upstream.
//!
//! Prefer not to emit request bodies, headers, provider URLs, or provider error bodies
//! at all. This sanitizer is defense-in-depth for selected textual fields, not a
//! substitute for keeping secret-bearing fields out of tracing events.

use std::net::IpAddr;

/// Remove URL material and redact common identifiers/secrets before emitting text.
pub fn redact_sensitive(input: &str) -> String {
    redact_ethereum_addresses(&redact_private_key_like(&redact_for_storage(input)))
}

/// Scrub storage-safe textual fields while preserving Ethereum addresses included as
/// explicit receipt params. This is not used for logs, where addresses are shortened.
pub fn redact_for_storage(input: &str) -> String {
    let without_urls = redact_urls(input);
    let without_named_secrets = redact_named_secrets(&without_urls);
    redact_ip_literals(&without_named_secrets)
}

fn redact_urls(input: &str) -> String {
    const SCHEMES: [&[u8]; 4] = [b"https://", b"http://", b"wss://", b"ws://"];
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < bytes.len() {
        let scheme = SCHEMES.iter().find(|scheme| {
            bytes
                .get(index..index + scheme.len())
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(scheme))
        });
        if let Some(scheme) = scheme {
            output.push_str("[REDACTED_URL]");
            index += scheme.len();
            while index < bytes.len()
                && !matches!(
                    bytes[index],
                    b' ' | b'\n'
                        | b'\r'
                        | b'\t'
                        | b'"'
                        | b'\''
                        | b'<'
                        | b'>'
                        | b')'
                        | b']'
                        | b'}'
                        | b','
                        | b';'
                )
            {
                index += 1;
            }
            continue;
        }

        let ch = input[index..].chars().next().expect("valid UTF-8 boundary");
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

fn redact_named_secrets(input: &str) -> String {
    const NAMES: [&str; 12] = [
        "access_token",
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "client_secret",
        "private_key",
        "privatekey",
        "password",
        "secret",
        "token",
        "credential",
    ];
    let lower = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < bytes.len() {
        let found = NAMES.iter().find_map(|name| {
            let end = index.checked_add(name.len())?;
            (lower.get(index..end) == Some(*name)
                && (index == 0
                    || !bytes[index - 1].is_ascii_alphanumeric() && bytes[index - 1] != b'_'))
                .then_some(*name)
        });
        if let Some(name) = found {
            let mut value_start = index + name.len();
            while bytes.get(value_start).is_some_and(u8::is_ascii_whitespace) {
                value_start += 1;
            }
            if bytes
                .get(value_start)
                .is_some_and(|byte| *byte == b'=' || *byte == b':')
            {
                value_start += 1;
                while bytes.get(value_start).is_some_and(u8::is_ascii_whitespace) {
                    value_start += 1;
                }
                output.push_str(&input[index..value_start]);
                output.push_str("[REDACTED]");
                index = value_start;
                let is_authorization = name == "authorization";
                while index < bytes.len() && !is_secret_delimiter(bytes[index], is_authorization) {
                    index += 1;
                }
                continue;
            }
        }

        let ch = input[index..].chars().next().expect("valid UTF-8 boundary");
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

fn is_secret_delimiter(byte: u8, authorization: bool) -> bool {
    if authorization {
        matches!(
            byte,
            b'\n' | b'\r' | b',' | b'"' | b'\'' | b'<' | b'>' | b'}'
        )
    } else {
        matches!(
            byte,
            b' ' | b'\n' | b'\r' | b'\t' | b'&' | b',' | b';' | b'"' | b'\'' | b'<' | b'>' | b'}'
        )
    }
}

fn redact_private_key_like(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < bytes.len() {
        let has_prefix = bytes
            .get(index..index + 2)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"0x"));
        let key_start = index + if has_prefix { 2 } else { 0 };
        let key_end = key_start + 64;
        let has_boundary = index == 0 || !bytes[index - 1].is_ascii_hexdigit();
        if has_boundary
            && key_end <= bytes.len()
            && bytes[key_start..key_end].iter().all(u8::is_ascii_hexdigit)
            && !bytes.get(key_end).is_some_and(u8::is_ascii_hexdigit)
        {
            output.push_str("[REDACTED_PRIVATE_KEY]");
            index = key_end;
            continue;
        }

        let ch = input[index..].chars().next().expect("valid UTF-8 boundary");
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

fn redact_ethereum_addresses(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < bytes.len() {
        let is_prefix = bytes
            .get(index..index + 2)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"0x"));
        let has_boundary = index == 0 || !bytes[index - 1].is_ascii_hexdigit();
        if is_prefix && has_boundary && index + 42 <= bytes.len() {
            let end = index + 42;
            let address = &bytes[index + 2..end];
            let next_is_hex = bytes.get(end).is_some_and(u8::is_ascii_hexdigit);
            if address.iter().all(u8::is_ascii_hexdigit) && !next_is_hex {
                output.push_str("0x");
                for byte in &bytes[index + 2..index + 6] {
                    output.push(char::from(*byte));
                }
                output.push('…');
                index = end;
                continue;
            }
        }

        let ch = input[index..].chars().next().expect("valid UTF-8 boundary");
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

fn redact_ip_literals(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < bytes.len() {
        let is_ip_char = |byte: u8| byte.is_ascii_hexdigit() || matches!(byte, b'.' | b':' | b'%');
        if is_ip_char(bytes[index]) && (index == 0 || !is_ip_char(bytes[index - 1])) {
            let candidate_end = (index..bytes.len())
                .take_while(|position| is_ip_char(bytes[*position]))
                .last()
                .map_or(index, |position| position + 1);

            // Try progressively shorter prefixes to handle IPv4 literals followed by a port.
            let ip_end = (index + 1..=candidate_end)
                .rev()
                .find(|end| input[index..*end].parse::<IpAddr>().is_ok());
            if let Some(end) = ip_end {
                output.push_str("[REDACTED_IP]");
                index = end;
                continue;
            }
        }

        let ch = input[index..].chars().next().expect("valid UTF-8 boundary");
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write,
        sync::{Arc, Mutex},
    };

    use super::*;

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("capture lock")
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn emitted_logs_keep_operational_context_but_redact_secrets() {
        const KEY: &str = "SUPERSECRETKEY1234567890";
        const ADDRESS: &str = "0x1234567890abcdef1234567890abcdef12345678";
        const IP: &str = "203.0.113.7";
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            let detail = format!(
                "provider unavailable at https://rpc.example/v3/{KEY}?apikey={KEY} from {IP}; address={ADDRESS}; token={KEY}"
            );
            tracing::info!(
                event = "provider_probe",
                detail = %redact_sensitive(&detail),
                "provider capability probe completed"
            );
        });

        let logs =
            String::from_utf8(captured.0.lock().expect("capture lock").clone()).expect("UTF-8 log");
        assert!(logs.contains("provider capability probe completed"));
        assert!(logs.contains("provider_probe"));
        for secret in [
            KEY,
            ADDRESS,
            IP,
            "apikey=",
            "https://",
            "?apikey=",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "AUTH-TOKEN",
        ] {
            assert!(!logs.contains(secret), "log leaked {secret:?}: {logs}");
        }
        assert!(logs.contains("[REDACTED_URL]"));
        assert!(logs.contains("[REDACTED_IP]"));
        assert!(logs.contains("0x1234…"));
    }

    #[test]
    fn strips_urls_and_redacts_ip_address_and_ethereum_address() {
        let input = "call https://rpc.example/rpc?token=secret from 127.0.0.1 for 0x1111111111111111111111111111111111111111";
        let output = redact_sensitive(input);
        assert!(!output.contains("https://"));
        assert!(!output.contains("?token=secret"));
        assert!(!output.contains("127.0.0.1"));
        assert!(!output.contains("0x1111111111111111111111111111111111111111"));
        assert!(output.contains("[REDACTED_URL]"));
        assert!(output.contains("[REDACTED_IP]"));
        assert!(output.contains("0x1111…"));
    }

    #[test]
    fn redacts_bare_private_keys_and_authorization_values() {
        let private_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let output = redact_sensitive(&format!(
            "private key {private_key}; authorization: Bearer AUTH-TOKEN"
        ));
        assert!(!output.contains(private_key));
        assert!(!output.contains("AUTH-TOKEN"));
        assert!(output.contains("[REDACTED_PRIVATE_KEY]"));
    }
}
