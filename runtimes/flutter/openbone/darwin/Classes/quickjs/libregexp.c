// Forwarder: CocoaPods only compiles files inside the pod, so this pulls in QuickJS's libregexp.c from cpp/third_party/quickjs
// (quickjs-ng, MIT; found through HEADER_SEARCH_PATHS, which the podspec points at the bundled or repository runtime).
#include "quickjs/libregexp.c"
