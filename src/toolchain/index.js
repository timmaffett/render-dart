// The Dart -> JavaScript toolchain, free of Render specifics.
//
// Kept separate so it can be extracted into a general Dart/Node bridge if one
// is ever wanted; nothing in here knows what a workflow is.
module.exports = {
  ...require('./dart-sdk'),
  ...require('./compile'),
};
