import { describe, expect, it } from 'vitest';
import { capText as serverCap } from '../../shared/src/index.ts';
import { capText, isEnvFile, isExcluded, mask, toolContent } from '../hooks/core.ts';

const R = '[REDACTED]';

describe('mask: secrets never leave the machine', () => {
  it.each([
    ['an Anthropic key', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345 end', `key ${R} end`],
    ['an OpenAI-style key', 'OPENAI sk-proj4f9Hq2LkVn8Zx1Rt6Yb3Wc7Ud0Ae5', `OPENAI ${R}`],
    ['a GitHub token', 'token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', `token ${R}`],
    ['a GitHub fine-grained token', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123', R],
    ['an AWS access key', 'AKIAIOSFODNN7EXAMPLE', R],
    ['a Slack token', 'xoxb-1234567890-abcdefghij', R],
    ['a Google API key', 'AIzaSyA-1234567890abcdefghijklmnopqrstuv', R],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', R],
    ['a bearer header', 'curl -H "Authorization: Bearer abc.def-ghi_jkl012345"', `curl -H "Authorization: Bearer ${R}"`],
    ['a password in a URL', 'postgres://orb:s3cr3t-Pass@db:5432/x', `postgres://orb:${R}@db:5432/x`],
    ['NAME=value for a secret-looking name', 'ORB_TOKEN=abc123 NEO4J_PASSWORD="p w" PORT=4040', `ORB_TOKEN=${R} NEO4J_PASSWORD=${R} PORT=4040`],
    ['a JSON secret field', '{"password": "hunter2", "user": "me"}', `{"password": "${R}", "user": "me"}`],
  ])('%s', (_name, input, want) => {
    expect(mask(input)).toBe(want);
  });

  it('a private key block, whole', () => {
    const pem = 'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter';
    expect(mask(pem)).toBe(`before\n${R}\nafter`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'pnpm exec vitest run packages/mod --reporter=dot; skip the token bucket test; keys and values';
    expect(mask(text)).toBe(text);
  });
});

// Issue #63. Fixtures that look like a vendor's live key are built from parts, so a push scanner does not read the test as a leak.
const stripe = ['sk', 'live', '51HxQwErTyUiOpAsDfGhJkLzXcVbNm9'].join('_');
const google = ['ya29', 'a0AfH6SMBxQwErTyUiOpAsDfGhJkLzXcVbNm'].join('.');
const slack = ['https://hooks.slack', 'com/services/T0123ABCD/B0123ABCD/AbCdEfGhIjKlMnOpQrStUvWx'].join('.');
const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'; // AWS's documented example: 40 characters, mixed case, a digit and slashes
const sha1 = '3f786850e387550fdab836ed7e6dc881de23001b';
const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sri = `sha512-${'aB3+/xY9'.repeat(10)}aB3+/xY9aB3+/x==`; // the shape of a lockfile's integrity, 88 base64 characters

describe('mask: the shapes that used to leak (#63)', () => {
  it.each([
    ['a Stripe live key', `charge with ${stripe} now`, `charge with ${R} now`],
    ['a Stripe restricted test key', ['rk', 'test', '51HxQwErTyUiOpAsDfGhJkLz'].join('_'), R],
    ['an AWS secret after its access key', `AKIAIOSFODNN7EXAMPLE ${awsSecret}`, `${R} ${R}`],
    ['an AWS secret as a CLI argument', `aws configure set aws_secret_access_key ${awsSecret}`, `aws configure set aws_secret_access_key ${R}`],
    ['an AWS secret in credentials-file form (lowercase name)', `aws_secret_access_key = ${awsSecret}`, `aws_secret_access_key = ${R}`],
    ['--password with a space', 'mysqldump --password hunter2 shop', `mysqldump --password ${R} shop`],
    ['--password=', 'tool --user me --password=hunter2 --verbose', `tool --user me --password=${R} --verbose`],
    ['--password with a quoted value that holds a space', 'tool --password "two words" --verbose', `tool --password ${R} --verbose`],
    ['--password with an escaped quote, as in a stringified tool input', String.raw`{"command":"tool --password \"two words\" go"}`, String.raw`{"command":"tool --password ${R} go"}`],
    ['--token, --api-key and --client-secret', 'a --token t0k3n b --api-key k3y c --client-secret s3cr3t', `a --token ${R} b --api-key ${R} c --client-secret ${R}`],
    ['mysql -pPASSWORD', 'mysql -u root -phunter2 -e "select 1"', `mysql -u root -p${R} -e "select 1"`],
    ['mysqldump -pPASSWORD in a pipeline', 'docker exec db mysqldump -u root -phunter2 shop | gzip', `docker exec db mysqldump -u root -p${R} shop | gzip`],
    ['7z -p"PASSWORD"', '7z a -p"my secret" out.7z src', `7z a -p${R} out.7z src`],
    ['an X-Api-Key header', 'curl -H "X-Api-Key: 0a1b2c3d4e5f" https://x.example', `curl -H "X-Api-Key: ${R}" https://x.example`],
    ['an X-Api-Key header inside a stringified tool input', String.raw`{"command":"curl -H \"x-api-key: abc123\" url"}`, String.raw`{"command":"curl -H \"x-api-key: ${R}\" url"}`],
    ['an X-Auth-Token and an X-Amz-Security-Token header', 'X-Auth-Token: abc\nX-Amz-Security-Token: def', `X-Auth-Token: ${R}\nX-Amz-Security-Token: ${R}`],
    ['lowercase api_key= and password=', 'api_key=abc123 password=hunter2 port=4040', `api_key=${R} password=${R} port=4040`],
    ['a camelCase apiKey assignment', 'const cfg = { apiKey: "abc123" }', `const cfg = { apiKey=${R} }`],
    ['npm _authToken', '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789', `//registry.npmjs.org/:_authToken=${R}`],
    ['a Google OAuth access token', `access ${google} end`, `access ${R} end`],
    ['a Slack webhook URL', `curl -X POST ${slack} -d x`, `curl -X POST https://hooks.slack.com/services/${R} -d x`],
    ['a Cookie header', 'curl -H "Cookie: sid=abc123; theme=dark" https://x.example', `curl -H "Cookie: ${R}" https://x.example`],
    ['a Set-Cookie header', 'HTTP/1.1 200 OK\nSet-Cookie: sid=abc123; Path=/; HttpOnly\nContent-Type: text/html', `HTTP/1.1 200 OK\nSet-Cookie: ${R}\nContent-Type: text/html`],
    ['--cookie', 'curl --cookie "sid=abc123" url', `curl --cookie ${R} url`],
    ['a cookie field in JSON', '{"cookie": "sid=abc123", "path": "/"}', `{"cookie": "${R}", "path": "/"}`],
    ['a long hex token named in the text', `the token is ${sha256} (keep it)`, `the token is ${R} (keep it)`],
    ['a long hex secret after a space or a colon', `secret ${sha1}\napi key: ${sha256}`, `secret ${R}\napi key: ${R}`],
    ['token=, auth_token= and GITHUB_TOKEN=', 'token=abc auth_token=def GITHUB_TOKEN=ghi', `token=${R} auth_token=${R} GITHUB_TOKEN=${R}`],
    ['apiKey: "x"', 'apiKey: "x"', `apiKey=${R}`],
    ['a name that ends in a secret word, with dashes, underscores or camelCase', 'client-secret=a dbPassword=b my_key=c userCredential=d oauth_auth=e db_passwd=f', `client-secret=${R} dbPassword=${R} my_key=${R} userCredential=${R} oauth_auth=${R} db_passwd=${R}`],
    ['a secret inside a value that is not one', 'url=https://x.example/?token=abc123 go', `url=https://x.example/?token=${R} go`],
    ['a JSON field named like a secret, camelCase or dashed', '{"apiKey": "a", "client-secret": "b", "auth_token": "c", "max_tokens": "1024x"}', `{"apiKey": "${R}", "client-secret": "${R}", "auth_token": "${R}", "max_tokens": "1024x"}`],
    ['curl -u user:pass', 'curl -u me:hunter2 https://x.example', `curl -u me:${R} https://x.example`],
    ['curl --user user:pass and --user=', 'curl --user me:hunter2 a; curl --user=me:hunter2 b', `curl --user me:${R} a; curl --user=me:${R} b`],
    ['curl -u with a quoted value that holds a space', 'curl -u "me:two words" url', `curl -u "me:${R}" url`],
    ['curl -u with an escaped quote, as in a stringified tool input', String.raw`{"command":"curl -u \"me:two words\" url"}`, String.raw`{"command":"curl -u \"me:${R}\" url"}`],
    ['curl -u with a colon in the password', 'docker exec web curl -s -u me:a:b url', `docker exec web curl -s -u me:${R} url`],
    ['sshpass -p', 'sshpass -p hunter2 ssh me@host', `sshpass -p ${R} ssh me@host`],
    ['sshpass -p with a quoted value, and attached', 'sshpass -p "two words" ssh a; sshpass -phunter2 ssh b', `sshpass -p ${R} ssh a; sshpass -p${R} ssh b`],
    ['sshpass -p after its other options, with ssh -p after the password', 'sshpass -f x -v -p hunter2 ssh -p 2222 me@host', `sshpass -f x -v -p ${R} ssh -p 2222 me@host`],
    ['a private key cut before its END line', 'out\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow', `out\n${R}`],
    ['a long hex token inside stringified JSON', String.raw`{"command":"curl -d '{\"token\":\"${sha1}\"}'"}`, String.raw`{"command":"curl -d '{\"token\":\"${R}\"}'"}`],
  ])('%s', (_name, input, want) => {
    expect(mask(input)).toBe(want);
  });
});

describe('mask: look-alikes stay readable (#63)', () => {
  it.each([
    ['a commit SHA in git log', `commit ${sha1}\nAuthor: Alfredo <a@b.example>\nDate:   Sat Oct 24 2026`],
    ['a SHA on its own, from rev-parse or checkout', `git checkout ${sha1}\n${sha1}`],
    ['a short SHA in a commit line', '[fix/63-masking 805ae55] fix(mod): mask the secret shapes'],
    ['a SHA after the word commit or hash', `merge commit ${sha1}, hash ${sha256}`],
    ['a UUID', 'session 123e4567-e89b-12d3-a456-426614174000 started'],
    ['a UUID in JSON', '{"session_id":"123e4567-e89b-12d3-a456-426614174000","id":"9f86d081-884c-4d65-9a2f-eaa0c55ad015"}'],
    ['a sha256 in a Cargo.lock line', `checksum = "${sha256}"`],
    ['a sha256 digest, Docker style', `FROM node@sha256:${sha256}`],
    ['an integrity hash in a pnpm lockfile line', `/vitest@5.0.5: resolution: {integrity: ${sri}}`],
    ['an integrity hash in package-lock', `"integrity": "${sri}"`],
    ['an ordinary --port 4040', 'node server.js --port 4040 --host 127.0.0.1'],
    ['PORT=4040', 'PORT=4040 pnpm start'],
    ['--token-file, which names a path', 'tool --token-file ./token.txt'],
    ['--max-tokens', 'claude -p x --max-tokens 4096'],
    ['docker -p, attached or not', 'docker run -p 8080:80 -p8081:81 nginx'],
    ['ssh -p with the port attached', 'ssh -p2222 me@host'],
    ['gcc -pthread and find -path, -prune', 'gcc -pthread a.c; find . -path ./node_modules -prune -print'],
    ['mkdir -p', 'mkdir -p out/logs'],
    ['mysql -P (the port) and a bare -p with the database after it', 'mysql -h db -P3306 -u root -p shop'],
    ['a path of 40 characters or more', '/Users/alfredorubin/WebstormProjects/agent-orb/packages/mod/hooks/core.ts'],
    ['a 40-character identifier with no digit', 'const someVeryLongCamelCaseIdentifierNamedFoo = 1'],
    ['max_tokens and num_tokens: the plural is a count', 'claude -p x max_tokens=1024 max_tokens: 4096 num_tokens=3 tokens_used=12'],
    ['key inside a longer word', 'keyboard=us monkey=1 MONKEY=2 whiskey: rye'],
    ['a digits-only value is never a secret', 'auth=1 token=123456 retry_key: 42 key="7"'],
    ['a JSON max_tokens with a quoted count', '{"max_tokens": "4096", "num_tokens": "3"}'],
    ['curl -u with no password, and a port', 'curl -u me https://x.example:8080/path'],
    ['ssh -p 2222', 'ssh -p 2222 me@host'],
    ['sshpass -e or -f, then ssh -p', 'sshpass -e ssh -p 2222 me@host; sshpass -f ./pw ssh -p 2222 me@host'],
    ['cookies in prose', 'the cookies: three of them were from the banner'],
    ['tokens counts in JSON', '{"input_tokens": 1234, "output_tokens": 56}'],
  ])('%s', (_name, text) => {
    expect(mask(text)).toBe(text);
  });
});

// Issue #63: mask() runs on captured tool output in the plugin, so crafted output must not hang it. Each unit is the repeating
// shape that made one pattern quadratic (or would, in the next pattern someone adds); 200 KB used to take seconds to minutes.
describe('mask: its cost grows with the length of the input, not its square (#63)', () => {
  it.each([
    'X-', 'a-', 'eyJ-', 'sk-', 'a', 'TOKEN', 'Token', 'mariadb-', 'mysql ', 'mysql -p"', '-----BEGIN PRIVATE KEY-----', '-----BEGIN ',
    'a:', 'a://', 'x://a:', 'token ', 'token=', 'a=', '"a": "', '--token "', 'Authorization: ', 'X-Api-Key ', 'curl -u "', 'curl ',
    'sshpass -f a ', 'sshpass ', ' ', '"', "'",
  ])('200 KB of %j', (unit) => {
    const text = unit.repeat(Math.ceil(200_000 / unit.length));
    const start = performance.now();
    mask(text);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('still masks a secret that sits after the adversarial run', () => {
    const run = 'X-'.repeat(50_000);
    expect(mask(`${run} postgres://orb:s3cr3t@db ${run}eyJ-${run} TOKEN=abc`)).toBe(`${run} postgres://orb:${R}@db ${run}eyJ-${run} TOKEN=${R}`);
  });
});

describe('capText', () => {
  it('agrees with the server, character for character', () => {
    const long = 'x'.repeat(10) + 'y'.repeat(50_000) + 'z'.repeat(10);
    expect(capText(long)).toBe(serverCap(long));
    expect(capText('short')).toBe('short');
  });
});

describe('isEnvFile', () => {
  it.each([['/r/.env', true], ['/r/deploy/.env', true], ['.env.local', true], ['/r/.env.production', true], ['/r/env.ts', false], ['/r/.envrc', false], [undefined, false]])('%s → %s', (p, want) => {
    expect(isEnvFile(p)).toBe(want);
  });
});

describe('isExcluded', () => {
  const project = { cwd: '/Users/me/work/client-loader', name: 'client-loader', git_remote: 'github.com/acme/client-loader' };
  it('matches by repo name, remote, owner/repo or path', () => {
    expect(isExcluded(project, 'client-loader')).toBe(true);
    expect(isExcluded(project, 'other, acme/client-loader')).toBe(true);
    expect(isExcluded(project, 'github.com/acme/client-loader')).toBe(true);
    expect(isExcluded(project, '/Users/me/work')).toBe(true);
  });
  it('does not match a prefix of a name or a sibling path', () => {
    expect(isExcluded(project, 'client')).toBe(false);
    expect(isExcluded(project, '/Users/me/wor')).toBe(false);
    expect(isExcluded(project, '')).toBe(false);
  });
});

describe('toolContent', () => {
  it('input as JSON without the envelope, output as the model read it, both masked', () => {
    expect(toolContent('Bash', { command: 'echo $ORB_TOKEN', description: 'x' }, 'ORB_TOKEN=abc\nok')).toEqual({
      input: '{"command":"echo $ORB_TOKEN","description":"x"}',
      output: `ORB_TOKEN=${R}\nok`,
    });
  });
  it('never sends a .env file: no output for a Read, no contents for a Write or Edit', () => {
    expect(toolContent('Read', { file_path: '/r/.env' }, 'NEO4J_PASSWORD=x')).toEqual({ input: '{"file_path":"/r/.env"}', output_skipped: 'env-file' });
    expect(toolContent('Write', { file_path: '/r/.env', content: 'A=1' }, 'ok')).toEqual({ input: '{"file_path":"/r/.env","content":"[contents not sent]"}', output: 'ok' });
    expect(toolContent('Edit', { file_path: '/r/.env.local', old_string: 'A=1', new_string: 'A=2' }, 'ok').input)
      .toBe('{"file_path":"/r/.env.local","old_string":"[contents not sent]","new_string":"[contents not sent]"}');
  });
  it('caps a huge output', () => {
    expect(toolContent('Read', { file_path: '/r/big.txt' }, 'q'.repeat(100_000)).output!.length).toBeLessThan(33_000);
  });
});
