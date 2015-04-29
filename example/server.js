var zetta = require('zetta');
var Starter = require('../index');
var app = require('./apps/wemolight_app');

zetta()
  .use(Starter)
  .use(app)
  .listen(1337);
