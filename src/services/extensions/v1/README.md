# Extensions v1

- **Base path:** `/extensions/v1`
- **Deprecated:** 5 November 2026
- **Badge URL EOL:** 5 February 2027 at 00:00 UTC
- **List, detail, and version EOL:** To be announced

The February cutoff applies only to badge URLs. List, detail, and plain-text version endpoints remain available. Their EOL date will be announced separately and will be at least six months after a stable FOSSBilling release ships the v2 extension installer ([FOSSBilling#4636](https://github.com/FOSSBilling/FOSSBilling/pull/4636)).

FOSSBilling 0.8.9 still uses v1. Upgrade integrations to [extensions v2](../v2/README.md); installations need a stable release containing the v2 installer before the remaining v1 endpoints can retire.

## Migration

| v1 endpoint         | v2 replacement                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /list`         | `GET /extensions/v2/extensions`                                                                               |
| `GET /{id}`         | `GET /extensions/v2/extensions/{id}`                                                                          |
| `GET /{id}/version` | Read `version` from the v2 detail response (the selected latest release, or newest stable release by default) |

V2 lists use cursor pagination, not v1 limit/offset pagination. Use type `module` instead of `mod`. Releases carry full `requires.fossbilling` constraints; consumers must evaluate that constraint rather than a derived minimum.

## Temporary badge rewrites

The Worker no longer handles `/extensions/v1/{id}/badges/{type}`. Cloudflare URL Rewrite Rules on the `fossbilling.net` zone route public GET/HEAD requests to v2, preserving the query string:

| Old badge type            | v2 badge type |
| ------------------------- | ------------- |
| `version`                 | `version`     |
| `license`                 | `license`     |
| `min_fossbilling_version` | `fossbilling` |

The minimum-version URL now displays the full requirement. Types match case-insensitively; v2 handles rendering and validation. Unknown types have no rewrite. Local requests and service bindings bypass the rules and have no v1 badge handler.

[cloudflare-rules.json](cloudflare-rules.json) records the Cloudflare API payloads. The URL rewrite ruleset is `f603898b72c84b4cb728ed935e23f043`; rule refs begin `extensions_v1_badge_`. Deploy these rules before removing the Worker handler.

The response-header ruleset is `d2f24f1a139d4087b11de7bed3f6549c`. Rule `extensions_v1_deprecation` adds `Deprecation` and a v2 docs link to all original v1 URLs. Rule `extensions_v1_sunset` adds the February `Sunset` only to original badge URLs, including rewritten requests. Other v1 endpoints have no fixed Sunset date. Removal at EOL is manual.

On 5 February 2027, remove the three badge rewrite rules and `extensions_v1_sunset`. Keep the remaining v1 service, its list-cache invalidation, and `extensions_v1_deprecation` until the separately announced whole-API EOL. At that later date, remove those remaining components. Delete Cloudflare rules by ref, preserving unrelated zone rules.
