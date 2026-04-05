# Generic n8n Flow for `ndeploy` Credential Fallback

This folder contains a generic workflow template for the optional fallback used by:

```bash
ndeploy credentials update <workspace> --fill
```

The idea is simple:

1. `ndeploy` first tries the public DEV API.
2. If some credentials still have no `data`, it calls this webhook.
3. The webhook exports local DEV credentials, filters only the requested ones, and returns:

```json
{
  "credentials": [
    { "dev_id": "abc", "data": { "apiKey": "..." } },
    { "dev_id": "def", "data": null }
  ]
}
```

## Files

- `ndeploy-dev-credential-export.workflow.json`
  Importable n8n workflow template.
- `instructions.md`
  This setup guide.

## What You Must Change

Before activating the workflow, replace these placeholders:

1. Token placeholder in the `Validate Request` node:

```js
const expectedToken = 'your-token-here';
```

2. Verify that the n8n host has the `n8n` CLI available and can run credential export:

```bash
n8n export:credentials --all --decrypted --output="$TMP_FILE"
```

3. Optional webhook path in the `Webhook` node:

```text
ndeploy/dev/credential-export
```

## How To Import It

1. Open n8n.
2. Create a new workflow.
3. Use the import option and load `ndeploy-dev-credential-export.workflow.json`.
4. Open `Validate Request` and replace `your-token-here` with a real shared secret.
5. Open `Export Credentials` only if you need to adapt the export command for your host.
6. Save the workflow.
7. Test it with the webhook test URL.
8. Activate it only after the test returns the expected payload.

## Expected Request

Method:

```text
POST
```

Headers:

```text
Content-Type: application/json
X-NDEPLOY-TOKEN: your-token-here
```

Request body:

```json
{
  "credentials": [
    {
      "dev_id": "abc",
      "id": "abc",
      "name": "OpenAI Account",
      "type": "openAiApi"
    }
  ]
}
```

## Expected Response

Success:

```json
{
  "credentials": [
    {
      "dev_id": "abc",
      "data": {
        "apiKey": "..."
      }
    }
  ]
}
```

Validation error:

```json
{
  "error": "credentials_must_be_an_array",
  "code": "BAD_REQUEST"
}
```

Unauthorized:

```json
{
  "error": "invalid_token",
  "code": "UNAUTHORIZED"
}
```

Internal error:

```json
{
  "error": "internal_error",
  "code": "INTERNAL_ERROR"
}
```

## Example `curl`

OK:

```bash
curl -X POST "https://your-n8n/webhook/ndeploy/dev/credential-export" \
  -H "Content-Type: application/json" \
  -H "X-NDEPLOY-TOKEN: your-token-here" \
  -d '{
    "credentials": [
      { "dev_id": "abc", "id": "abc", "name": "OpenAI Account", "type": "openAiApi" }
    ]
  }'
```

Unauthorized:

```bash
curl -X POST "https://your-n8n/webhook/ndeploy/dev/credential-export" \
  -H "Content-Type: application/json" \
  -H "X-NDEPLOY-TOKEN: wrong-token" \
  -d '{ "credentials": [{ "dev_id": "abc" }] }'
```

Bad request:

```bash
curl -X POST "https://your-n8n/webhook/ndeploy/dev/credential-export" \
  -H "Content-Type: application/json" \
  -H "X-NDEPLOY-TOKEN: your-token-here" \
  -d '{ "credentials": {} }'
```

## How To Connect It With `ndeploy`

After your workflow is active, configure these environment variables in the machine that runs `ndeploy`:

```env
N8N_DEV_CREDENTIAL_EXPORT_URL=https://your-n8n/webhook/ndeploy/dev/credential-export
N8N_DEV_CREDENTIAL_EXPORT_TOKEN=your-token-here
```

Then run:

```bash
ndeploy credentials update <workspace> --fill
```

## Security Notes

- Keep using `X-NDEPLOY-TOKEN` as the webhook auth mechanism.
- Do not log the full exported `data` object.
- Keep the exported credential dump in a temporary file and delete it in the same shell step after printing the JSON response.
- Return `data: null` when a credential cannot be resolved.

## Compatibility Note

This template keeps the same architecture requested for the workflow:

- `Webhook`
- `Code` for auth and body validation
- `Execute Command` for exporting credentials
- `Code` for filtering the exported JSON in memory
- `Respond to Webhook`

This version already avoids `fs` inside the `Code` node. It also prefers the native `n8n export:credentials` CLI instead of relying on a custom host script.
