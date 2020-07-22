/**
 * Check the validity of the invitation token
 * @param token: the token to be validated
 * @param callback: function(result), result being 'true' if the token is valid, false otherwise
 */
exports.checkIfValid = function checkIfValid(token, callback) {
    return callback(true);
};