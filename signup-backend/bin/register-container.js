#!/usr/bin/env node
// bin/register-container.js — admin CLI to create a signup token for a new
// customer container. Run on the control container after preparing the
// customer's LXC + DNS + Mikrotik forward.

const { createToken, listTokens, deleteToken } = require('../lib/db');

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  register-container <domain> <container-ip> [--user <user>]
      Create a new signup token for a customer's container.

  register-container --list
      Show all registered tokens.

  register-container --revoke <token>
      Delete a token (the signup URL will become invalid).

Examples:
  register-container customer-foo.openclaw.example.com 10.0.0.12
  register-container customer-bar.openclaw.example.com 10.0.0.13 --user testuser
`);
  process.exit(1);
}

if (args.length === 0 || args[0] === '-h' || args[0] === '--help') usage();

const baseUrl = process.env.SIGNUP_BASE_URL || 'https://signup.metaelearning.online';

if (args[0] === '--list') {
  const rows = listTokens();
  if (rows.length === 0) {
    console.log('(no tokens)');
    process.exit(0);
  }
  for (const r of rows) {
    const url = `${baseUrl}/?token=${r.token}`;
    console.log(`${r.status.padEnd(13)} ${r.domain.padEnd(50)} ${r.container_ip.padEnd(15)} ${url}`);
  }
  process.exit(0);
}

if (args[0] === '--revoke') {
  if (!args[1]) {
    console.error('--revoke requires a token');
    process.exit(1);
  }
  const result = deleteToken(args[1]);
  console.log(result.changes > 0 ? '✓ Token revoked' : '✗ Token not found');
  process.exit(result.changes > 0 ? 0 : 1);
}

const [domain, containerIp, ...rest] = args;
if (!domain || !containerIp) usage();

let containerUser = 'root';
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--user' && rest[i + 1]) {
    containerUser = rest[i + 1];
    i++;
  }
}

const token = createToken({ domain, containerIp, containerUser });
const signupUrl = `${baseUrl}/?token=${token}`;

console.log('');
console.log('  ✓ Container registered');
console.log('');
console.log(`    Domain       : ${domain}`);
console.log(`    Container IP : ${containerIp}  (user: ${containerUser})`);
console.log(`    Token        : ${token}`);
console.log('');
console.log('    Share this URL with your customer:');
console.log(`    → ${signupUrl}`);
console.log('');
