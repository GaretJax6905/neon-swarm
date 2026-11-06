"""Shared local HTTP server for actual browser tests, without a fixed port."""

from threading import Thread

import pytest
from werkzeug.serving import make_server

import app as web


@pytest.fixture
def live_server(monkeypatch):
    """Serve the real Flask app locally and stop only this fixture's server.

    The socket is bound before the browser can use the yielded URL. An OS-chosen
    port avoids interrupting a student's app already running on port 5050.
    """
    monkeypatch.setitem(web.app.config, "TESTING", True)
    server = make_server("127.0.0.1", 0, web.app)
    worker = Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.05},
        name="pytest-local-http",
        daemon=True,
    )
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()
        if worker.is_alive():
            pytest.fail("The browser test's local HTTP server did not stop.")
