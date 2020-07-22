// @flow

// Middleware that verifies the presence of an authorization token
// 
module.exports = (req: express$Request, res: express$Response, next: express$NextFunction) => {
  req.headers['authorization'] = getAuth(req);
  next();
};

function getAuth(req): ?string {
  let authorizationHeader = req.header('authorization');

  if (authorizationHeader != null) {
    const basic = authorizationHeader.split(' ');
    if (basic[0].toLowerCase() === 'basic' && basic[1]) {
      authorizationHeader = Buffer.from(basic[1], 'base64').toString('ascii').split(':')[0];
    }
    if (Array.isArray(authorizationHeader)) return authorizationHeader[0];
    return authorizationHeader;        
  }

  // assert: no authorization in header, let's check query: 
  const authFromQuery = req.query.auth; 

  if (authFromQuery == null) return null; 
  if (Array.isArray(authFromQuery)) return authFromQuery[0];
  return authFromQuery;
}
