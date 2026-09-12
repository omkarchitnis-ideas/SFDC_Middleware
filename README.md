# ☁️ SFDC Middleware & Central Token Gateway

An enterprise-grade, zero-dependency Salesforce middleware that vends auto-renewing access tokens, provides SOQL-over-HTTP query execution with relationship flattening, and streams large dataset exports to Excel and CSV.

---

## 🌟 Key Features

* **🔑 Central Token Vending Service (`GET /auth/token`)**:
  * Headless authentication directly against Salesforce Partner SOAP API (zero SF CLI or browser required).
  * In-memory token caching with proactive TTL renewal (every 2 hours).
  * Auto-recovery on Salesforce `401 / INVALID_SESSION_ID`.
  * Manual force-refresh endpoint (`POST /auth/token/refresh`).
* **⚡ SOQL-over-HTTP (`POST /query`)**:
  * Secure SOQL query execution with API key authentication (`x-api-key`).
  * Automatic recursive flattening of nested Salesforce relationship objects (e.g. `Owner.Name`, `What.CaseNumber`).
* **📊 Large Dataset Streaming (`POST /export`)**:
  * Incremental streamed output to `.xlsx` (Excel) or `.csv` in ~2000-record chunks with flat memory usage.
* **💻 Interactive Browser SQL Console**:
  * CodeMirror SOQL query runner served at `http://localhost:4000/`.
* **🐳 Docker & Windows Native Execution**:
  * Single command Docker deployment or silent Windows background runner (`start_sfdc_silent.vbs`).

---

## 🚀 Quick Start

### 1. Configure Environment
Copy `.env.example` to `.env` and provide your credentials:
```bash
PORT=4000
API_KEY=your_secure_api_key_here
SFDC_INSTANCE_URL=https://ideas-sas.my.salesforce.com
SFDC_USERNAME=your.email@ideas.com
SFDC_PASSWORD=YourPasswordAndSecurityTokenCombined
```

### 2. Run with Docker (Recommended)
```bash
docker compose up -d
```

### 3. Run with Node.js
```bash
npm install
npm start
```

### 4. Run Silently on Windows (Background)
Double-click `start_sfdc_silent.vbs` or execute `start_sfdc.bat`.

---

## 📡 API Reference

### 1. Token Vending
* **`GET /auth/token`** *(or `GET /api/sfdc/token`)*
  * **Headers**: `x-api-key: <API_KEY>` (or query parameter `?key=<API_KEY>`)
  * **Response**:
    ```json
    {
      "success": true,
      "instanceUrl": "https://ideas-sas.my.salesforce.com",
      "accessToken": "00D...",
      "tokenExpiration": 1789202267213,
      "expiresInSeconds": 7195,
      "authMethod": "soap_direct"
    }
    ```

* **`POST /auth/token/refresh`**
  * Forces an immediate re-login to Salesforce and returns a freshly minted token.

### 2. SOQL Execution
* **`POST /query`**
  * **Body**: `{"soql": "SELECT Id, Subject, Owner.Name FROM Task LIMIT 10"}`
  * **Response**: `{ "count": 10, "records": [...] }`

### 3. Streamed Export
* **`POST /export`**
  * **Body**: `{"soql": "SELECT Id, Subject FROM Task", "format": "xlsx"}`
  * Streams raw Excel or CSV binary stream directly to client.

---

## 🐍 Python Client Usage

```python
import requests

TOKEN_URL = "http://localhost:4000/auth/token"
API_KEY = "your_api_key_here"

# 1. Fetch active token
res = requests.get(TOKEN_URL, headers={"x-api-key": API_KEY}).json()
access_token = res["accessToken"]
instance_url = res["instanceUrl"]

# 2. Run query directly or via middleware
headers = {"Authorization": f"Bearer {access_token}"}
sf_res = requests.get(f"{instance_url}/services/data/v60.0/query", headers=headers, params={"q": "SELECT Id, Subject FROM Task LIMIT 5"})
print(sf_res.json()["records"])
```

---

## 👤 Author
Developed and maintained by **Omkar Chitnis** ([@omkarchitnis-ideas](https://github.com/omkarchitnis-ideas)).
