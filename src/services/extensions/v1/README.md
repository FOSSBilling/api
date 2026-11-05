# Extensions v1

**Base path:** `/extensions/v1`  
**Deprecated:** 5 November 2026  
**End of life:** 5 February 2027 at 00:00 UTC

Upgrade integrations to [extensions v2](../v2/README.md) before EOL. Older FOSSBilling installations using v1 must upgrade to a release containing the v2 extension installer ([FOSSBilling#4636](https://github.com/FOSSBilling/FOSSBilling/pull/4636)).

## Migration

| v1 endpoint         | v2 replacement                                                                |
| ------------------- | ----------------------------------------------------------------------------- |
| `GET /list`         | `GET /extensions/v2/extensions`                                               |
| `GET /{id}`         | `GET /extensions/v2/extensions/{id}`                                          |
| `GET /{id}/version` | Read the latest release's tag (`releases[0].tag`) from the v2 detail response |

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

The response-header ruleset is `d2f24f1a139d4087b11de7bed3f6549c` (rule ref `extensions_v1_sunset`). It matches original v1 URLs, including rewritten badges, and adds `Deprecation`, `Sunset`, and a link to the v2 docs. Endpoint removal at EOL is manual.

At EOL, remove the remaining v1 service and mount, its list-cache invalidation, and the four temporary Cloudflare rules. Delete only these rules by ref, preserving any other rules subsequently added to the zone rulesets.
