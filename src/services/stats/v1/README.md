# Stats v1

**Base Path:** `/stats/v1`

Release statistics visualization for FOSSBilling versions. Reuses the release
data already fetched by the versions service rather than calling GitHub itself.

## Endpoints

### GET `/`

Returns a client-side rendered HTML page with Chart.js visualizations.

### GET `/data`

Returns the aggregated statistics behind those charts as JSON.

## Charts

- Release Size Graph (line)
- PHP Version Requirements (line)
- Patches Per Release (bar)
- Releases Per Year (bar)

## Caching

Stats are cached with a 24-hour TTL and follow the same caching patterns as the
versions service, including its graceful handling of GitHub API errors — a
failed refresh serves the previous data rather than erroring.
