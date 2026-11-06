use std::{env, fs, path::PathBuf, time::Duration};

use alloy_primitives::{Address, U256};
use serde_json::{json, Value};
use veriq_verifier::bounds;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();

    let mut args = env::args().skip(1);
    let address = args
        .next()
        .ok_or("usage: capture <address> <out.json> [slot,slot,...]")?
        .parse::<Address>()?;
    let out = PathBuf::from(args.next().ok_or("missing output path")?);
    let slots: Vec<U256> = match args.next() {
        Some(input) if !input.trim().is_empty() => input
            .split(',')
            .map(|slot| {
                let slot = slot.trim().trim_start_matches("0x");
                U256::from_str_radix(slot, 16).map_err(|err| format!("invalid slot: {err}"))
            })
            .collect::<Result<_, _>>()?,
        _ => Vec::new(),
    };

    let rpc = env::var("EXEC_RPC").map_err(|_| "EXEC_RPC is required")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;

    let block = rpc_call(
        &client,
        &rpc,
        "eth_getBlockByNumber",
        json!(["finalized", false]),
    )
    .await?;
    if block.is_null() {
        return Err("finalized block unavailable".into());
    }

    let number = parse_u64(block.get("number"))?;
    let hash = block
        .get("hash")
        .and_then(Value::as_str)
        .ok_or("block hash missing")?
        .to_string();
    let state_root = block
        .get("stateRoot")
        .and_then(Value::as_str)
        .ok_or("stateRoot missing")?
        .to_string();

    let slot_params: Vec<String> = slots.iter().map(|slot| format!("{slot:#066x}")).collect();
    let proof = match rpc_call(
        &client,
        &rpc,
        "eth_getProof",
        json!([
            format!("{address:#x}"),
            slot_params,
            {"blockHash": hash, "requireCanonical": true}
        ]),
    )
    .await
    {
        Ok(proof) => proof,
        Err(_) => {
            rpc_call(
                &client,
                &rpc,
                "eth_getProof",
                json!([
                    format!("{address:#x}"),
                    slot_params,
                    format!("0x{number:x}")
                ]),
            )
            .await?
        }
    };

    let fixture = json!({
        "address": format!("{address:#x}"),
        "slots": slot_params,
        "block": {
            "number": number,
            "hash": hash,
            "stateRoot": state_root,
        },
        "proof": proof,
    });

    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&out, serde_json::to_vec_pretty(&fixture)?)?;
    println!(
        "wrote {} for address {address:#x} at block {number}",
        out.display()
    );
    Ok(())
}

async fn rpc_call(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    params: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let response = client
        .post(url)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(format!("provider HTTP {}", response.status()).into());
    }
    let body = read_body_limited(response).await?;
    let value: Value = serde_json::from_slice(&body)?;
    if let Some(error) = value.get("error") {
        return Err(format!("provider error: {error}").into());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "missing result".into())
}

async fn read_body_limited(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if let Some(length) = response.content_length() {
        bounds::check_response_size(usize::try_from(length)?)?;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let length = body.len() + chunk.len();
        if length > bounds::MAX_RESPONSE_BYTES {
            return Err("response exceeds 2 MiB".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_u64(value: Option<&Value>) -> Result<u64, Box<dyn std::error::Error>> {
    let text = value.and_then(Value::as_str).ok_or("quantity missing")?;
    let text = text.strip_prefix("0x").unwrap_or(text);
    Ok(u64::from_str_radix(text, 16)?)
}
