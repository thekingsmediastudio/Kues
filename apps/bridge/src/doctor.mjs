import { execSync } from 'node:child_process';

console.log('=== KUES // WIRELESS-ADB BRIDGE DOCTOR ===');
try {
  const out = execSync('adb devices -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out.trim());
} catch {
  console.log('[INFO] `adb` binary not found or no physical Android device attached in this environment.');
  console.log('Cloud Judge Mode (`SimDeviceDriver` with visible SIMULATED badge) is active by default.');
  console.log('\nTo pair a physical Android phone over Wireless Debugging (45s):');
  console.log('  1. Phone: Settings -> Developer Options -> Wireless debugging -> Pair device with pairing code');
  console.log('  2. Laptop: adb pair <ip>:<port> <6-digit-code> && adb connect <ip>:<port>');
}
