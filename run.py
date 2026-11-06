"""Start the game locally. Saved Python changes restart the server.

HOST=0.0.0.0 lets other devices on your network connect (see README).
"""

import os

from app import app

if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5050")),
        debug=False,
        use_reloader=True,
    )
