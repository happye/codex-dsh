// Test instrumentation, not an OS sandbox. Inherited by the isolated Host only.
const net = require('node:net');
const dgram = require('node:dgram');
const { syncBuiltinESMExports } = require('node:module');
const local = h => ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(String(h).toLowerCase());
const deny = () => { process.stderr.write('[e2e-egress-denied]\n'); throw new Error('E2E non-loopback networking denied'); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === 'object' ? first.host ?? 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  const pipe = first && typeof first === 'object' ? first.path : typeof first === 'string';
  if (!pipe && !local(host)) deny();
  return connect.apply(this, args);
};
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  if (!local(args.findLast(a => typeof a === 'string') ?? 'localhost')) deny();
  return send.apply(this, args);
};
syncBuiltinESMExports();
