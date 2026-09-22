# Security policy

Token Flow captures and stores local AI-agent traffic. Reports may involve
credentials, proxy routing, generated certificates, trace databases, exports,
or private prompt and tool data.

Do not open a public issue containing secrets or raw traces. Use GitHub private
vulnerability reporting for this repository, or contact the maintainer
privately when that is unavailable.

Include sanitized reproduction steps, affected versions, likely exposure, and
any known mitigation. Treat these areas as security-sensitive:

- authorization headers, cookies, API keys, and OAuth state;
- trace redaction, storage, import, and export;
- reverse/forward proxy routing and non-loopback binding;
- generated CA and host certificates;
- HTML or JSON views containing captured private context.

Raw traces can contain prompts, tool definitions, tool results, file paths, and
response bodies even when common authorization headers have been removed.
