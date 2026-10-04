# Central Alerts v1

**Base Path:** `/central-alerts/v1`

The Central Alerts service provides targeted notifications to FOSSBilling installations based on version ranges. This allows administrators to push important security alerts, update notices, or general announcements to specific versions of FOSSBilling.

## API Endpoints

### GET `/list`

Retrieve all alerts in the system. Optional `limit` (integer 1–100) and
`offset` enable pagination. An unusable limit keeps the full-list response;
`offset` without a usable limit returns 422. An omitted or unusable offset
with a usable limit defaults to zero.

Successful responses are edge-cached for 60 seconds by the effective page.
Unknown query parameters and equivalent pagination spellings reuse the same
entry. This endpoint is public: Authorization does not affect its response or
bypass its cache. Validation failures and database errors are not cached.

**Response:**

```json
{
  "result": {
    "alerts": [
      {
        "id": "1",
        "title": "Security Alert",
        "message": "Please update your installation",
        "type": "danger",
        "dismissible": false,
        "min_fossbilling_version": "0.0.0",
        "max_fossbilling_version": "0.5.2",
        "include_preview_branch": false,
        "buttons": [
          {
            "text": "Learn More",
            "link": "https://fossbilling.org/security",
            "type": "info"
          }
        ],
        "datetime": "2023-06-30T21:43:03+00:00"
      }
    ]
  },
  "error": null
}
```

**Error Response:**

```json
{
  "result": null,
  "error": {
    "message": "Database connection failed",
    "code": "DATABASE_ERROR"
  }
}
```

## Alert Types

The `type` field accepts: `success`, `info`, `warning`, `danger`

## Database

Uses D1 database binding `DB_CENTRAL_ALERTS`. Initialize with the setup script in `src/services/central-alerts/v1/scripts/`.

Public GET responses use the edge cache even when an unused Authorization header is supplied; these representations do not depend on credentials.
