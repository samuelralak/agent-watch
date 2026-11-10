// agentwatch-signer: signs the user's agentwatch messages with a key that lives in this Mac's
// Secure Enclave and answers only to a fingerprint.
//
//   agentwatch-signer create-key
//       Makes a key and prints {"key": "...", "publicKey": "..."}, both base64. `key` is only a
//       reference to the key: it is useless on another Mac, and useless here without a touch.
//
//   agentwatch-signer sign <key-file>
//       Signs what it is asked to on standard input, one JSON request per line, until standard
//       input closes. A request is {"id": 1, "data": "<base64>", "reason": "...", "approve": false}
//       and its answer {"id": 1, "signature": "<base64>"} or {"id": 1, "error": "..."}.
//
// The first signature asks for a fingerprint and shows `reason`. Later ones from the same process
// do not ask again, unless a request sets `approve`: that one shows its own reason and needs its
// own touch.
import CryptoKit
import Foundation
import LocalAuthentication

typealias EnclaveKey = SecureEnclave.P256.Signing.PrivateKey

struct Request: Decodable {
  let id: Int
  let data: String
  let reason: String
  let approve: Bool?
}

struct Reply: Encodable {
  let id: Int
  var signature: String?
  var error: String?
}

struct SignerError: Error, CustomStringConvertible {
  let description: String
}

func write<Value: Encodable>(_ value: Value) {
  guard let line = try? JSONEncoder().encode(value) else {
    return
  }

  FileHandle.standardOutput.write(line + Data([0x0a]))
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

/// A key that can only sign, only on this Mac, and only with a fingerprint enrolled today.
func createKey() throws {
  var error: Unmanaged<CFError>?

  guard
    let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      &error
    )
  else {
    throw SignerError(description: "the key's protection could not be set up")
  }

  let key = try EnclaveKey(accessControl: access)

  write([
    "key": key.dataRepresentation.base64EncodedString(),
    "publicKey": key.publicKey.derRepresentation.base64EncodedString(),
  ])
}

/// The key behind `reference`, asking for a fingerprint with `reason` when it is first used.
func openKey(_ reference: Data, reason: String) throws -> EnclaveKey {
  let context = LAContext()

  context.localizedReason = reason

  return try EnclaveKey(dataRepresentation: reference, authenticationContext: context)
}

func readReference(_ path: String) throws -> Data {
  let text = try String(contentsOfFile: path, encoding: .utf8)

  guard let reference = Data(base64Encoded: text.trimmingCharacters(in: .whitespacesAndNewlines))
  else {
    throw SignerError(description: "\(path) does not hold a key")
  }

  return reference
}

/// Answers signing requests until standard input closes.
func sign(keyFile: String) throws {
  let reference = try readReference(keyFile)
  var windowKey: EnclaveKey?

  while let line = readLine() {
    guard let request = try? JSONDecoder().decode(Request.self, from: Data(line.utf8)) else {
      continue
    }

    do {
      guard let data = Data(base64Encoded: request.data) else {
        throw SignerError(description: "the request carries nothing to sign")
      }

      let key: EnclaveKey

      if request.approve == true {
        key = try openKey(reference, reason: request.reason)
      } else {
        key = try windowKey ?? openKey(reference, reason: request.reason)
        windowKey = key
      }

      let signature = try key.signature(for: data)

      write(Reply(id: request.id, signature: signature.derRepresentation.base64EncodedString()))
    } catch {
      write(Reply(id: request.id, error: "\(error.localizedDescription)"))
    }
  }
}

guard SecureEnclave.isAvailable else {
  fail("This Mac has no Secure Enclave.")
}

let arguments = CommandLine.arguments

do {
  if arguments.count == 2 && arguments[1] == "create-key" {
    try createKey()
  } else if arguments.count == 3 && arguments[1] == "sign" {
    try sign(keyFile: arguments[2])
  } else {
    fail("usage: agentwatch-signer create-key | sign <key-file>")
  }
} catch {
  fail("\(error)")
}
