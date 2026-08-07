# Prebuilt NetMQ dependencies

This directory temporarily stores the prebuilt managed dependencies required by `PABCCompilerController` and `ZMQServerPas`. Build tooling copies them into the generated repository-root `bin/` directory; they are not packaged from this directory directly.

| File | Upstream package/version | License | SHA-256 |
| --- | --- | --- | --- |
| `NetMQ.dll` | NetMQ, assembly 4.0.1.7 | [MPL-2.0](LICENSE-MPL-2.0.txt) | `7986D1EEFCAF175ECDCBA9C865BE5C1EDDE4EBF3B64A8267E61536DD1FFCB1AB` |
| `AsyncIO.dll` | AsyncIO 0.1.69 | [MPL-2.0](LICENSE-MPL-2.0.txt) | `7124E586DDA40A009FCF31EB3F224F6D378AF1116FCA76CEB31770D93C0CC0C7` |
| `NaCl.dll` | NaCl.Net 0.1.13 | [MPL-2.0](LICENSE-MPL-2.0.txt) | `830DECE975B8264E69035D2171AEE0A0DA3F3D02EF16D47D90B48FACF2B62BF9` |
| `System.Threading.Tasks.Extensions.dll` | System.Threading.Tasks.Extensions 4.5.4 (`net461`) | [MIT](LICENSE-System.Threading.Tasks.Extensions.txt) | `4F81FFD0DC7204DB75AFC35EA4291769B07C440592F28894260EEA76626A23C6` |

Upstream sources and license information:

- [NetMQ](https://github.com/zeromq/netmq)
- [AsyncIO](https://github.com/somdoron/AsyncIO)
- [NaCl.Net](https://www.nuget.org/packages/NaCl.Net/0.1.13)
- [System.Threading.Tasks.Extensions](https://www.nuget.org/packages/System.Threading.Tasks.Extensions/4.5.4)

The notices supplied by the Microsoft package are preserved in [THIRD-PARTY-NOTICES-System.Threading.Tasks.Extensions.txt](THIRD-PARTY-NOTICES-System.Threading.Tasks.Extensions.txt).

These binaries are kept only as a temporary reproducible input. The planned replacement is a source-based dependency build for the target platform.
