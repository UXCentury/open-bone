// Forwarder: CocoaPods only compiles files inside the pod, so this pulls in cpp/src/scripting_quickjs.cpp
// (found through HEADER_SEARCH_PATHS, which the podspec resolves past Flutter's plugin symlink).
#include "cpp/src/scripting_quickjs.cpp"
