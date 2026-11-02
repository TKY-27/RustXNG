use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use tower::ServiceExt;

use rustxng::web::{AppState, image_proxy, router};
use rustxng::{Searcher, Settings};

#[tokio::test]
async fn signed_private_hosts_never_reach_the_media_upstream() {
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let upstream = Router::new().fallback(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        async { ([(header::CONTENT_TYPE, "image/png")], "image bytes") }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let origin = format!("http://localhost.:{}", address.port());
    let mut settings = Settings::defaults();
    settings.engines.clear();
    settings.server.image_proxy = true;
    settings.server.secret_key = "media-test".into();
    settings
        .outgoing
        .proxies
        .insert("all".into(), format!("http://{address}"));
    let app = router(AppState::new(Searcher::new(settings).unwrap()));
    let urls = [
        image_proxy::proxied_url("", "media-test", &format!("{origin}/image.png")),
        format!(
            "/favicon_proxy?url={}&h={}",
            rustxng::engine::util::encode(&origin),
            image_proxy::signature("media-test", &origin)
        ),
    ];
    let mut statuses = Vec::new();
    for url in urls {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        statuses.push(response.status());
    }
    server.abort();
    assert_eq!(statuses, [StatusCode::FORBIDDEN; 2]);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
}
