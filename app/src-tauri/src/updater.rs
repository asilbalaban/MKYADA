//! Release check against GitHub. No auto-update: the frontend shows a dialog
//! and opens the release page in the browser if the user accepts.

use semver::Version;
use serde::Serialize;

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/asilbalaban/MKYADA/releases/latest";

#[derive(Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub url: String,
}

pub async fn check(current: &str) -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("mkyada-app")
        .build()
        .map_err(|e| e.to_string())?;
    let resp: serde_json::Value = client
        .get(LATEST_RELEASE_API)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let tag = resp
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("no releases found")?;
    let url = resp
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/asilbalaban/MKYADA/releases/latest")
        .to_string();
    let latest = tag.trim_start_matches('v');
    let available = match (Version::parse(latest), Version::parse(current)) {
        (Ok(l), Ok(c)) => l > c,
        _ => false,
    };
    Ok(UpdateInfo {
        available,
        current: current.to_string(),
        latest: latest.to_string(),
        url,
    })
}
