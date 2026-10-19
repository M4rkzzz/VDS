// Deliberately exits without release/finally to exercise recovery in a different
// OS process. This helper talks only to its parent's loopback router fixture.
const { UpnpPortMapper } = require('../../desktop/upnp-port-mapper');
const { UpnpMappingJournal } = require('../../desktop/upnp-mapping-journal');
const config = JSON.parse(process.argv[2]);
process.on('message', (message) => { if (message === 'exit-without-cleanup') process.exit(86); });
const mapper = new UpnpPortMapper({ discoveryAddress: '127.0.0.1', discoveryPort: config.discoveryPort,
  journal: config.disableJournal ? null : new UpnpMappingJournal({ directory: config.directory }) });
const operation = config.claimOnly ? (async () => {
  const [record] = await mapper.journal.orphans();
  const claim = await mapper.journal.claim(record);
  if (!claim) throw new Error('fixture-claim-unavailable');
  return { mapping: { claimed: true } };
})() : mapper.createLease('127.0.0.1', config.candidate, 180);
operation.then((lease) => {
  process.send({ ready: true, mapping: lease.mapping });
}).catch((error) => { process.send({ error: error.message }); process.exitCode = 1; process.disconnect(); });
