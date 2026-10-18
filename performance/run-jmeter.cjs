const fs = require('node:fs');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Handle quoted CSV fields (including commas and escaped quotes).
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if (char === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  return rows.map(values => Object.fromEntries(headers.map((key, index) => [key, values[index]])));
}

async function main() {
  const home = option('--jmeter-home', process.env.JMETER_HOME);
  if (!home) throw new Error('Provide --jmeter-home or JMETER_HOME for your portable JMeter installation.');
  const jar = path.resolve(home, 'bin', 'ApacheJMeter.jar');
  if (!fs.existsSync(jar)) throw new Error(`JMeter not found: ${jar}`);
  const java = option('--java', process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java');
  const label = option('--label', 'measurement');
  if (!/^[a-zA-Z0-9-]+$/.test(label)) throw new Error('Label must contain only letters, numbers, and hyphens.');
  const directory = path.join(__dirname, 'results', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(directory, { recursive: true });
  const server = fork(path.join(__dirname, 'server.cjs'), [], { silent: true });
  let logs = '';
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  const serverExited = once(server, 'exit');
  let jmeter;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
      server.once('message', message => { clearTimeout(timer); resolve(message.port); });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    });
    const args = ['-Xms256m', '-Xmx512m', '-jar', jar, '-n', '-t', path.join(__dirname, 'event-lookup.jmx'),
      '-Jhost=127.0.0.1', `-Jport=${port}`, '-Jjmeter.save.saveservice.output_format=csv',
      '-l', path.join(directory, 'samples.jtl'), '-j', path.join(directory, 'jmeter.log'),
      '-e', '-o', path.join(directory, 'report')];
    fs.writeFileSync(path.join(directory, 'environment.json'), JSON.stringify({ node: process.version, java, jar, port, label, args }, null, 2));
    jmeter = spawn(java, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    jmeter.stdout.on('data', data => { output += data; process.stdout.write(data); });
    jmeter.stderr.on('data', data => { output += data; process.stderr.write(data); });
    const timer = setTimeout(() => jmeter.kill(), 180000);
    let code;
    try { [code] = await once(jmeter, 'exit'); } finally { clearTimeout(timer); }
    fs.writeFileSync(path.join(directory, 'console.log'), output);
    if (code !== 0) throw new Error(`JMeter exited ${code}; inspect ${directory}`);
    const rows = parseCsv(fs.readFileSync(path.join(directory, 'samples.jtl'), 'utf8'));
    if (rows.length !== 15 || rows.some(row => row.success !== 'true' || row.responseCode !== '200')) {
      throw new Error(`Expected 15 successful samples; inspect ${directory}`);
    }
    const summary = ['GET two events', 'GET seven events'].map(name => {
      const times = rows.filter(row => row.label === name).map(row => Number(row.elapsed)).sort((a, b) => a - b);
      if (times.length !== 5) throw new Error(`Expected five samples for ${name}`);
      return { scenario: name, count: times.length, medianMs: times[2], minMs: times[0], maxMs: times.at(-1), samplesMs: times };
    });
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    console.table(summary.map(({ samplesMs, ...metrics }) => metrics));
    console.log(`Results: ${directory}`);
  } finally {
    if (jmeter && jmeter.exitCode === null) jmeter.kill();
    if (server.connected) server.send('stop');
    const timeout = setTimeout(() => server.kill(), 5000);
    await serverExited;
    clearTimeout(timeout);
    fs.writeFileSync(path.join(directory, 'server.log'), logs);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
