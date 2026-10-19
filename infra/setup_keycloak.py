"""Configure the local Keycloak for the demo: realm, clients, roles, users.

Mirrors what you would click through in the Keycloak admin console. Safe to re-run.
"""
import pathlib
import sys

import httpx

KC = "http://keycloak.office.local:8080"
REALM = "company"
EXT_ID = (pathlib.Path(__file__).parent / "keys" / "extension-id.txt").read_text().strip()

USERS = [
    # username, password, first, last, roles, attributes
    ("ravi", "ravi123", "Ravi", "Kumar", ["user"],
     {"emp_id": "EMP1042", "department": "Engineering", "manager": "Priya Sharma", "phone": "9876500011"}),
    ("anita", "anita123", "Anita", "Desai", ["user", "auditor"],
     {"emp_id": "EMP2001", "department": "Internal Audit", "manager": "CFO Office", "phone": "9876500022"}),
    ("priya", "priya123", "Priya", "Sharma", ["user"],
     {"emp_id": "EMP0900", "department": "Engineering", "manager": "CTO Office", "phone": "9876500044"}),
    ("admin1", "admin123", "Arjun", "Mehta", ["user", "admin"],
     {"emp_id": "EMP0001", "department": "IT", "manager": "CIO", "phone": "9876500033"}),
]
ATTRS = ["emp_id", "department", "manager", "phone"]


def main():
    c = httpx.Client(base_url=KC, timeout=30)
    tok = c.post("/realms/master/protocol/openid-connect/token", data={
        "grant_type": "password", "client_id": "admin-cli", "username": "admin", "password": "admin",
    }).raise_for_status().json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"

    if c.get(f"/admin/realms/{REALM}").status_code == 404:
        c.post("/admin/realms", json={"realm": REALM, "enabled": True, "sslRequired": "none",
                                      "displayName": "Company Intranet"}).raise_for_status()

    # Allow custom user attributes (emp_id, department...) — Keycloak 26 user profile
    up = c.get(f"/admin/realms/{REALM}/users/profile").raise_for_status().json()
    up["unmanagedAttributePolicy"] = "ENABLED"
    c.put(f"/admin/realms/{REALM}/users/profile", json=up).raise_for_status()

    for role in ["user", "auditor", "admin"]:
        c.post(f"/admin/realms/{REALM}/roles", json={"name": role})  # 409 if exists

    clients = {
        "browser-agent": {
            "clientId": "browser-agent", "name": "Office Assistant extension", "publicClient": True,
            "standardFlowEnabled": True, "directAccessGrantsEnabled": False,
            "redirectUris": [f"https://{EXT_ID}.chromiumapp.org/*"],
            "attributes": {"pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "+"},
            "protocolMappers": [
                {"name": a, "protocol": "openid-connect", "protocolMapper": "oidc-usermodel-attribute-mapper",
                 "config": {"user.attribute": a, "claim.name": a, "jsonType.label": "String",
                            "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true"}}
                for a in ATTRS
            ],
        },
        "intranet-apps": {
            "clientId": "intranet-apps", "name": "Intranet sites", "publicClient": False,
            "secret": "intranet-apps-secret", "standardFlowEnabled": True,
            "redirectUris": [f"http://{h}.office.local:8300/*" for h in ("helpdesk", "expenses", "rooms", "visitors", "canteen")],
        },
        "assistant-backend": {  # service account: lets the backend look up colleagues in the directory
            "clientId": "assistant-backend", "name": "Office Assistant backend", "publicClient": False,
            "secret": "assistant-backend-secret", "standardFlowEnabled": False, "serviceAccountsEnabled": True,
        },
        "hr-portal": {
            "clientId": "hr-portal", "name": "HR Leave Portal", "publicClient": False,
            "secret": "hr-portal-secret", "standardFlowEnabled": True,
            "redirectUris": ["http://hr.office.local:8200/*"],
        },
    }
    for cid, rep in clients.items():
        existing = c.get(f"/admin/realms/{REALM}/clients", params={"clientId": cid}).json()
        if existing:
            c.put(f"/admin/realms/{REALM}/clients/{existing[0]['id']}", json={**existing[0], **rep}).raise_for_status()
        else:
            c.post(f"/admin/realms/{REALM}/clients", json=rep).raise_for_status()

    # Directory read access for the backend's service account (realm-management: view-users)
    backend = c.get(f"/admin/realms/{REALM}/clients", params={"clientId": "assistant-backend"}).json()[0]
    sa = c.get(f"/admin/realms/{REALM}/clients/{backend['id']}/service-account-user").json()
    rm = c.get(f"/admin/realms/{REALM}/clients", params={"clientId": "realm-management"}).json()[0]
    view = c.get(f"/admin/realms/{REALM}/clients/{rm['id']}/roles/view-users").json()
    c.post(f"/admin/realms/{REALM}/users/{sa['id']}/role-mappings/clients/{rm['id']}", json=[view])

    for username, pw, first, last, roles, attrs in USERS:
        found = c.get(f"/admin/realms/{REALM}/users", params={"username": username, "exact": "true"}).json()
        rep = {"username": username, "enabled": True, "firstName": first, "lastName": last,
               "email": f"{username}@office.local", "emailVerified": True,
               "attributes": {k: [v] for k, v in attrs.items()}}
        if found:
            uid = found[0]["id"]
            c.put(f"/admin/realms/{REALM}/users/{uid}", json=rep).raise_for_status()
        else:
            c.post(f"/admin/realms/{REALM}/users", json=rep).raise_for_status()
            uid = c.get(f"/admin/realms/{REALM}/users", params={"username": username, "exact": "true"}).json()[0]["id"]
        c.put(f"/admin/realms/{REALM}/users/{uid}/reset-password",
              json={"type": "password", "value": pw, "temporary": False}).raise_for_status()
        role_reps = [c.get(f"/admin/realms/{REALM}/roles/{r}").json() for r in roles]
        c.post(f"/admin/realms/{REALM}/users/{uid}/role-mappings/realm", json=role_reps).raise_for_status()

    print(f"Keycloak realm '{REALM}' ready. Extension redirect: https://{EXT_ID}.chromiumapp.org/")


if __name__ == "__main__":
    sys.exit(main())
