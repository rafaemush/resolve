/**
 * Generate the USDC receiving wallet OFFLINE on this machine. The private key is written ONLY to
 * ~/.resolve/receiving-wallet.json (mode 600); only the address goes into .env / Worker secrets.
 * Move the key to a hardware wallet before balances matter.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".resolve");
const file = join(dir, "receiving-wallet.json");
mkdirSync(dir, { recursive: true, mode: 0o700 });
let address: string;
if (existsSync(file)) {
  address = (JSON.parse(readFileSync(file, "utf8")) as { address: string }).address;
  console.log("existing wallet:", address, "(", file, ")");
} else {
  const pk = generatePrivateKey();
  address = privateKeyToAccount(pk).address;
  writeFileSync(file, JSON.stringify({ address, privateKey: pk, created_at: new Date().toISOString(), chain: "base", purpose: "Resolve USDC receiving address" }, null, 2), { mode: 0o600 });
  console.log("new wallet:", address, "-> private key saved to", file, "(mode 600; never leaves this machine)");
}
const env = readFileSync(".env", "utf8");
if (!/^USDC_RECEIVING_ADDRESS=.+/m.test(env)) { appendFileSync(".env", `USDC_RECEIVING_ADDRESS=${address}\n`); console.log(".env: USDC_RECEIVING_ADDRESS set"); }
else console.log(".env already has USDC_RECEIVING_ADDRESS");
