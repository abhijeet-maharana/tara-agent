// Prints the Mac's thermal state as a number: 0 nominal, 1 fair, 2 serious, 3 critical.
// Compiled once by install.sh (swiftc -O), because ProcessInfo is not reachable from a shell.
import Foundation
print(ProcessInfo.processInfo.thermalState.rawValue)
