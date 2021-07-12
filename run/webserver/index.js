// server related
const express = require('express');
const https = require('https');
const serveStatic = require('serve-static');
const cors = require('cors');
const apiProxy = require('http-proxy-middleware');
const httpProxy = require('http-proxy');
// authentication
const authBasic = require('express-basic-auth');
// utils
const path = require('path');
const fs = require('fs');
const csp = require(`helmet-csp`);
const winston = require(`winston`);

// utils
const AuthModule = require('../authserver/auth');
const inMemoryConfig = require("../runtime.datastore");
const inMemoryConfigFromInputs = require('../runtime.datastore.config');
const runtimeOptions = new inMemoryConfig(inMemoryConfigFromInputs);

// auth options
const authOptions = runtimeOptions.config.auth;
const auth        = new AuthModule( runtimeOptions.config );
// cors
var corsOptions   = runtimeOptions.config.cors;
// csp
var cspOptions    = runtimeOptions.config.csp;
// proxy config
var proxyOptions  = runtimeOptions.config.proxy;
// web server config
let serverOptions = runtimeOptions.config.web;

// write proxy conf to file? (we need this for DEV mode)
if(inMemoryConfigFromInputs.proxyServerOptions.writeToFile) {
  runtimeOptions.writeProxyConfigToFile("../","proxy.conf.json");
}

// server(s)
const app = express();
let STARTUP_MSG = '';
//STARTUP_MSG += "\t RUNTIME OPTIONS: "+ JSON.stringify(inMemoryConfigFromInputs, undefined, 2);

// security options and middleware
if(corsOptions && corsOptions.origin) {
  STARTUP_MSG = STARTUP_MSG + '\n'+'-- CORS ENABLED --';
  app.options('*', cors(corsOptions)) // include before other routes
}
if(cspOptions) {
  //const cspOptions = require('../../auth/csp.conf');
  STARTUP_MSG = STARTUP_MSG + '\n'+'-- CSP ENABLED --';
  app.use(csp(cspOptions)); //csp options
}
// cors test endpoint
app.get('/cors/test', (req, res, next) => {
  res.status(200).json( authOptions );
});
app.post(`/api/csp/report`, (req, res) => {
  winston.warn(`CSP header violation`, req.body[`csp-report`])
  res.status(204).end();
});

// ------------------------------------------------------------------------

// check if SSL file(s) exist
if(serverOptions.ssl && serverOptions.ssl.certPath && serverOptions.ssl.keyPath){
  try {
    if (fs.existsSync(serverOptions.ssl.certPath) && fs.existsSync(serverOptions.ssl.keyPath)) {
      //file exists
      STARTUP_MSG = STARTUP_MSG + '\n'+'-- SSL ENABLED --';
      serverOptions.ssl.enabled = true;
    } else {
      serverOptions.ssl.enabled = false;
    }
  } catch(err) {
    serverOptions.ssl.enabled = false;
  }
}

// use basic authentication middleware ?
if( serverOptions.authBasicJson ){
  try  {
    app.use(authBasic({
      challenge: true,
      users: serverOptions.authBasicJson
    }));
    STARTUP_MSG = STARTUP_MSG + '\n'+'-- BASIC AUTH MODULE ENABLED --';
  } catch(err){
    STARTUP_MSG = STARTUP_MSG + '\n'+'-- BASIC AUTH MODULE DISABLED : '+ err +' --\n';
    serverOptions.authBasicJson = undefined;
    delete serverOptions.authBasicJson;
  }

} else {
  STARTUP_MSG = STARTUP_MSG + '\n'+'-- BASIC AUTH MODULE DISABLED : no basic auth json provided --';
}

// set up proxy tunnels
if(proxyOptions) {
  STARTUP_MSG = STARTUP_MSG + '\n'+'-- REVERSE PROXY PATHS SET UP --';

  for(proxyPath in proxyOptions){
    let proxyTargetOptions = proxyOptions[proxyPath];
    // add custom error handler to prevent XSS/Injection in to error response
    function onError(err, req, res) {
      res.writeHead(500, {
        'Content-Type': 'text/plain'
      });
      res.end('proxy encountered an error.');
    }
    proxyTargetOptions.onError = onError;
    //console.log('Proxy CFG: '+ proxyPath);
    //console.log(proxyTargetOptions);
    app.use(proxyPath, apiProxy(proxyTargetOptions));
    app.on('error', function(e) {
      console.log('Proxy Error: '+ e.message);
    });
  }
} else {
  STARTUP_MSG = STARTUP_MSG + '\n'+'-- REVERSE PROXY TUNNELS COULD NOT BE ENABLED --';
}

// static files
let staticPath  = path.resolve(path.join(__dirname, '../../', 'dist/entity-search-web-app'));
let webCompPath = path.resolve(path.join(__dirname, '../../', '/node_modules/@senzing/sdk-components-web/'));
app.use('/node_modules/@senzing/sdk-components-web', express.static(webCompPath));
app.use(express.static(staticPath));
//console.log('\n\n STATIC PATH: '+staticPath,'\n');

// admin auth tokens
const authRes = (req, res, next) => {
  const body = req.body;
  const encodedToken = (body && body.adminToken) ? body.adminToken : req.query.adminToken;

  res.status(200).json({
    tokenIsValid: true,
    adminToken: encodedToken
  });
};

if(authOptions && authOptions !== undefined) {
  app.get('/conf/auth', (req, res, next) => {
    res.status(200).json( authOptions );
  });
  app.get('/conf/auth/admin', (req, res, next) => {
    res.status(200).json( authOptions.admin );
  });
  app.get('/conf/auth/operator', (req, res, next) => {
    res.status(200).json( authOptions.operator );
  });

  if(authOptions.admin && authOptions.admin.mode === 'SSO' || authOptions.admin && authOptions.admin.mode === 'EXTERNAL') {
    const ssoResForceTrue = (req, res, next) => {
      res.status(200).json({
        authorized: true,
      });
    };
    const ssoResForceFalse = (req, res, next) => {
      res.status(401).json({
        authorized: false,
      });
    };
    // dunno if this should be a reverse proxy req or not
    // especially if the SSO uses cookies etc
    app.get('/sso/admin/status', ssoResForceTrue);
    app.get('/sso/admin/login', (req, res, next) => {
      res.sendFile(path.resolve(path.join(__dirname,'../../', '/auth/sso-login.html')));
    });
    //STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'---------------------';
    STARTUP_MSG = STARTUP_MSG + '\n'+'--- Auth SETTINGS ---';
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    //STARTUP_MSG = STARTUP_MSG + '\n'+'/admin area:';
    STARTUP_MSG = STARTUP_MSG + '\n'+ JSON.stringify(authOptions, null, "  ");
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    //STARTUP_MSG = STARTUP_MSG + '\n'+'/ operators:';
    //STARTUP_MSG = STARTUP_MSG + '\n'+ JSON.stringify(adminAuth.authConfig.admin, null, "  ");
    STARTUP_MSG = STARTUP_MSG + '\n'+'---------------------';

  } else if(authOptions.admin && authOptions.admin.mode === 'JWT' || authOptions.admin && authOptions.admin.mode === 'BUILT-IN') {
    const jwtRes = (req, res, next) => {
      const body = req.body;
      const encodedToken = (body && body.adminToken) ? body.adminToken : req.query.adminToken;

      res.status(200).json({
        tokenIsValid: true,
        adminToken: encodedToken
      });
    };
    const jwtResForceTrue = (req, res, next) => {
      res.status(200).json({
        tokenIsValid: true,
      });
    };
    /** admin endpoints */
    /*
    app.post('/jwt/admin/status', jwtResForceTrue);
    app.post('/jwt/admin/login', jwtResForceTrue);
    app.get('/jwt/admin/status', jwtResForceTrue);
    app.get('/jwt/admin/login', jwtResForceTrue);
    */

    app.post('/jwt/admin/status', auth.auth.bind(auth), jwtRes);
    app.post('/jwt/admin/login', auth.login.bind(auth));
    app.get('/jwt/admin/status', auth.auth.bind(auth), jwtRes);
    app.get('/jwt/admin/login', auth.auth.bind(auth), jwtRes);

    /** operator endpoints */
    if(authOptions.operator && authOptions.operator.mode === 'JWT') {
      // token auth for operators
      app.post('/jwt/status', auth.auth.bind(adminAuth), jwtRes);
      app.post('/jwt/login', auth.login.bind(adminAuth));
      app.get('/jwt/status', auth.auth.bind(adminAuth), jwtRes);
      app.get('/jwt/login', auth.auth.bind(adminAuth), jwtRes);
    } else {
      // always return true for operators
      app.post('/jwt/status', jwtResForceTrue);
      app.post('/jwt/login', jwtResForceTrue);
      app.get('/jwt/status', jwtResForceTrue);
      app.get('/jwt/login', jwtResForceTrue);
    }

    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'To access the /admin area you will need a Admin Token.';
    STARTUP_MSG = STARTUP_MSG + '\n'+'Admin Tokens are generated from a randomly generated secret unless one is specified with the -adminSecret flag.';
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'---------------------';
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'ADMIN SECRET: '+ auth.secret;
    STARTUP_MSG = STARTUP_MSG + '\n'+'ADMIN SEED:   '+ auth.seed;
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'ADMIN TOKEN:  ';
    STARTUP_MSG = STARTUP_MSG + '\n'+ auth.token;
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'---------------------';
    STARTUP_MSG = STARTUP_MSG + '\n'+'Copy and Paste the line above when prompted for the Admin Token in the admin area.';
  } else {
    // no auth
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'---------------------';
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'    CAUTION    ';
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'/admin path not protected via ';
    STARTUP_MSG = STARTUP_MSG + '\n'+'authentication mechanism.';
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'To add built-in Token authentication for the /admin path '
    STARTUP_MSG = STARTUP_MSG + '\n'+'set the \'SENZING_WEB_SERVER_ADMIN_AUTH_MODE="JWT"\' env variable ';
    STARTUP_MSG = STARTUP_MSG + '\n'+'or the \'adminAuthMode="JWT"\' command line arg.'
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'To add an external authentication check configure your ';
    STARTUP_MSG = STARTUP_MSG + '\n'+'proxy to resolve with a 401 or 403 header for ';
    STARTUP_MSG = STARTUP_MSG + '\n'+'"/admin/auth/status" requests to this instance.';
    STARTUP_MSG = STARTUP_MSG + '\n'+'Set the auth mode to SSO by setting \'SENZING_WEB_SERVER_ADMIN_AUTH_MODE="SSO"\'';
    STARTUP_MSG = STARTUP_MSG + '\n'+'A failure can be redirected by setting "SENZING_WEB_SERVER_ADMIN_AUTH_REDIRECT="https://my-sso.my-domain.com/path-to/login""';
    STARTUP_MSG = STARTUP_MSG + '\n'+'or via cmdline \'adminAuthRedirectUrl="https://my-sso.my-domain.com/path-to/login"\''

    STARTUP_MSG = STARTUP_MSG + '\n'+'---------------------';
    STARTUP_MSG = STARTUP_MSG + '\n'+'';
  }
}


// SPA page
let VIEW_VARIABLES = {
  "VIEW_PAGE_TITLE":"Entity Search",
  "VIEW_BASEHREF":"/",
  "VIEW_CSP_DIRECTIVES":""
}
if(cspOptions && cspOptions.directives) {
  // we have to dynamically serve the html
  // due to CSP not being smart enough about websockets
  let cspContentStr = "";
  let cspKeys       = Object.keys(cspOptions.directives);
  let cspValues     = Object.values(cspOptions.directives);

  for(var _inc=0; _inc < cspKeys.length; _inc++) {
    let cspDirectiveValue = cspValues[_inc] ? cspValues[_inc] : [];
    cspContentStr += cspKeys[_inc] +" "+ cspDirectiveValue.join(' ') +';\n';
  }
  cspContentStr = cspContentStr.trim();
  VIEW_VARIABLES.VIEW_CSP_DIRECTIVES = cspContentStr;
}
/** dynamically render SPA page with variables */
app.set('views', path.resolve(path.join(__dirname, '..'+path.sep, '..'+path.sep, 'dist/entity-search-web-app')));
app.set('view engine', 'pug');
app.get('*', (req, res) => {
  res.render('index', VIEW_VARIABLES);
});

// set up server(s) instance(s)
var ExpressSrvInstance;
var WebSocketProxyInstance;
var StartupPromises = [];
if( serverOptions && serverOptions.ssl && serverOptions.ssl.enabled ){
  // https
  const ssl_opts = {
    key: fs.readFileSync(serverOptions.ssl.keyPath),
    cert: fs.readFileSync(serverOptions.ssl.certPath)
  }
  ExpressSrvInstance = https.createServer(ssl_opts, app).listen(serverOptions.port)
  STARTUP_MSG_POST = '\n'+'SSL Express Server started on port '+ serverOptions.port;
  STARTUP_MSG_POST = STARTUP_MSG_POST + '\n'+'\tKEY: ', serverOptions.keyPath;
  STARTUP_MSG_POST = STARTUP_MSG_POST + '\n'+'\tCERT: ', serverOptions.certPath;
  STARTUP_MSG_POST = STARTUP_MSG_POST + '\n'+'';
  STARTUP_MSG = STARTUP_MSG_POST + STARTUP_MSG;
} else {
  // check if we need a websocket proxy
  let streamServerPromise = new Promise((resolve) => {
    if(serverOptions && serverOptions.streamServerDestUrl) {
      var wsProxy   = httpProxy.createServer({ 
        target: serverOptions.streamServerDestUrl,
        ws: true 
      });
      wsProxy.on('error', function(e) {
        console.log('WS Proxy Error: '+ e.message);
      });
      WebSocketProxyInstance = wsProxy.listen(serverOptions.streamServerPort || 8255, () => {
        console.log('[started] WS Proxy Server on port '+ (serverOptions.streamServerPort || 8255) +'. Forwarding to "'+ serverOptions.streamServerDestUrl +'"');
        resolve();
      });
      //STARTUP_MSG = 'WS Proxy Server started on port '+ (serverOptions.streamServerPort || 8255) +'. Forwarding to "'+ serverOptions.streamServerDestUrl +'"\n'+ STARTUP_MSG;
    } else {
      //STARTUP_MSG = STARTUP_MSG + '\n NO WS PROXY!!';
      console.log('NO WS PROXY!!', serverOptions);
      resolve();
    }
  }, (reason) => { 
    console.log('[error] WS Proxy Server: ', reason);
    reject(); 
  })
  StartupPromises.push(streamServerPromise);
  
  // http
  let webServerPromise = new Promise((resolve) => {
    ExpressSrvInstance = app.listen(serverOptions.port, () => {
      console.log('[started] Web Server on port '+ serverOptions.port);
      resolve();
    });
  }, (reason) => { 
    console.log('[error] Web Server', reason);
    reject(); 
  });
  StartupPromises.push(webServerPromise);
  //STARTUP_MSG = '\n'+'Express Server started on port '+ serverOptions.port +'\n'+ STARTUP_MSG;
}

console.log( STARTUP_MSG +'\n');
(async() => {
  await Promise.all(StartupPromises);
  console.log('\n\nPress any key to exit...');
  rl.prompt();
})()

// capture keyboard input for graceful exit
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
rl.on('line', (line) => {
  rl.question('Are you sure you want to exit? (Y/N)', (answer) => {
    if (answer.match(/^y(es)?$/i)) {
      let ShutdownPromises = [];

      if(WebSocketProxyInstance) {
        ShutdownPromises.push( new Promise((resolve) => {
          WebSocketProxyInstance.close(function () {
            console.log('[stopped] WS Proxy Server');
            resolve();
          });
        }));
      }
      ShutdownPromises.push( new Promise((resolve) => {
        ExpressSrvInstance.close(function () {
          console.log('[stopped] Web Server');
          resolve();
        });
      }));
      (async() => {
        await Promise.all(ShutdownPromises).catch((errors) => {
          console.error('Could not shutdown services cleanly');
        });
        process.exit(0);
      })();
    } else {
      console.log('\n\nPress any key to exit...');
      rl.prompt();
    }
  });
});
