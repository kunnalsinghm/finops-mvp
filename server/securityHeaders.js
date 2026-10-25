// securityHeaders.js - the Helmet options the server uses, in one place so a test can
// pin them. This is the EXISTING configuration moved out of index.js unchanged.
//
// What the Content-Security-Policy buys against injected markup in the dashboard
// (see public/render.js for the escaping that is the primary defence):
//   script-src 'self'          inline <script> blocks and javascript: URLs do not run
//   script-src-attr 'none'     (Helmet's default, kept) inline event handlers such as
//                              onerror= / onclick= do not run
//   form-action 'self', img-src 'self' data:, connect-src 'self'
//                              an injected form, image or fetch cannot send data to
//                              another origin
// It does NOT stop injected markup from rendering (a spoofed link or paragraph), which
// is why the dashboard also escapes. Do not add 'unsafe-inline' or 'unsafe-eval' to
// script-src: test/dashboardRender.test.js fails if you do.
const helmetOptions = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
};

module.exports = { helmetOptions };
