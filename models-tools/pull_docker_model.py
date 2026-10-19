"""Download a GGUF model from Docker Hub's ai/ namespace (Docker Model Runner OCI artifacts)."""
import json, sys, urllib.request, os

repo, tag, out = sys.argv[1], sys.argv[2], sys.argv[3]

def get(url, headers={}):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)

tok = json.load(get(f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"))["token"]
H = {"Authorization": f"Bearer {tok}"}
accept = ",".join(["application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
                   "application/vnd.docker.distribution.manifest.v2+json"])
m = json.load(get(f"https://registry-1.docker.io/v2/{repo}/manifests/{tag}", {**H, "Accept": accept}))
if "manifests" in m:
    m = json.load(get(f"https://registry-1.docker.io/v2/{repo}/manifests/{m['manifests'][0]['digest']}", {**H, "Accept": accept}))
layers = m["layers"]
for l in layers:
    print(l["mediaType"], round(l["size"] / 1e6, 1), "MB")
gguf = [l for l in layers if "weight" in l["mediaType"] or "gguf" in l["mediaType"]]
if "--list" in sys.argv:
    sys.exit()
layer = max(gguf, key=lambda l: l["size"])
r = get(f"https://registry-1.docker.io/v2/{repo}/blobs/{layer['digest']}", H)
done = 0
with open(out + ".part", "wb") as f:
    while chunk := r.read(1 << 20):
        f.write(chunk); done += len(chunk)
os.rename(out + ".part", out)
print("saved", out, round(done / 1e6, 1), "MB")
