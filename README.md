# Coffee, ranked

A static page that ranks coffee places by a weighted score. No build step, no dependencies.

## Run

The page loads JSON with `fetch`, so it needs to be served over HTTP (opening `index.html` directly won't work):

```sh
python -m http.server 8000
# then open http://localhost:8000
```
