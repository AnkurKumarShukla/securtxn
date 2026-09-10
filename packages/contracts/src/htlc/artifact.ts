// GENERATED — do not edit. Run: pnpm --filter @cp/contracts compile
//
// Source:   contracts/PaymentHtlc.sol
// Compiler: solc 0.8.36+commit.8a079791.Emscripten.clang
// Settings: optimizer enabled, 200 runs, evmVersion paris

/** ABI of the deployed escrow. `as const` so viem types every call from it. */
export const PAYMENT_HTLC_ABI = [
  {
    "inputs": [],
    "name": "AmountIsZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "HashlockIsZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LockAlreadyExists",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LockExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LockNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LockNotOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LockNotYetExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotThePayee",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PayeeIsZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PreimageDoesNotMatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TimelockNotInFuture",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TokenTransferFailed",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "lockId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "paymentRef",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "payee",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "preimage",
        "type": "bytes32"
      }
    ],
    "name": "Claimed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "lockId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "paymentRef",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "payee",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "payer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "hashlock",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "timelock",
        "type": "uint64"
      }
    ],
    "name": "Locked",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "lockId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "paymentRef",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "payer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "Refunded",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "lockId",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "preimage",
        "type": "bytes32"
      }
    ],
    "name": "claim",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "paymentRef",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "payer",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "payee",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "bytes32",
        "name": "hashlock",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "timelock",
        "type": "uint64"
      }
    ],
    "name": "computeLockId",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "lockId",
        "type": "bytes32"
      }
    ],
    "name": "getLock",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "payer",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "payee",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          },
          {
            "internalType": "bytes32",
            "name": "hashlock",
            "type": "bytes32"
          },
          {
            "internalType": "uint64",
            "name": "timelock",
            "type": "uint64"
          },
          {
            "internalType": "enum PaymentHtlc.Status",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "preimage",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "paymentRef",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PaymentHtlc.Lock",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "paymentRef",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "payee",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "bytes32",
        "name": "hashlock",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "timelock",
        "type": "uint64"
      }
    ],
    "name": "lock",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "lockId",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "lockId",
        "type": "bytes32"
      }
    ],
    "name": "refund",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

/** Creation bytecode. No constructor arguments — the escrow holds no config. */
export const PAYMENT_HTLC_BYTECODE = "0x6080604052348015600f57600080fd5b50610c098061001f6000396000f3fe608060405234801561001057600080fd5b50600436106100575760003560e01c80637249fbb61461005c57806384cc9dfb1461007157806392bcc78b14610084578063d6f27b58146100aa578063f8ccf32b146100ca575b600080fd5b61006f61006a366004610976565b6100dd565b005b61006f61007f36600461098f565b610227565b6100976100923660046109e5565b6103ed565b6040519081526020015b60405180910390f35b6100bd6100b8366004610976565b6106b3565b6040516100a19190610a7c565b6100976100d8366004610b0a565b6107bd565b6000818152602081905260408120906005820154600160401b900460ff16600381111561010c5761010c610a44565b0361012a57604051636086ee6f60e11b815260040160405180910390fd5b60016005820154600160401b900460ff16600381111561014c5761014c610a44565b1461016a5760405163a790acc560e01b815260040160405180910390fd5b600581015467ffffffffffffffff1642101561019957604051632077e24b60e21b815260040160405180910390fd5b60058101805460ff60401b19166803000000000000000017905580546007820154600383015460408051918252516001600160a01b039093169285917f6c5895acb60b66e78106939eaaa3976db6325f801ff434fe24ff7cb0a6795a5f919081900360200190a4600281015481546003830154610223926001600160a01b03908116921690610827565b5050565b6000828152602081905260408120906005820154600160401b900460ff16600381111561025657610256610a44565b0361027457604051636086ee6f60e11b815260040160405180910390fd5b60016005820154600160401b900460ff16600381111561029657610296610a44565b146102b45760405163a790acc560e01b815260040160405180910390fd5b60018101546001600160a01b031633146102e157604051638a0a643b60e01b815260040160405180910390fd5b600581015467ffffffffffffffff16421061030f576040516307b7d7dd60e51b815260040160405180910390fd5b600481015460408051602081018590520160405160208183030381529060405280519060200120146103545760405163d52cccfd60e01b815260040160405180910390fd5b6005810180546802000000000000000060ff60401b1990911617905560068101829055600181015460078201546040518481526001600160a01b039092169185907f8a5044083b72e4cfbb25f6fdc2a8b7c3380a3dbbbf234928bbcc943e0bfde3ba9060200160405180910390a46002810154600182015460038301546103e8926001600160a01b03908116921690610827565b505050565b600083600003610410576040516310eb483f60e21b815260040160405180910390fd5b6001600160a01b0386166104375760405163952a7bb960e01b815260040160405180910390fd5b8261045557604051632445ee8960e21b815260040160405180910390fd5b428267ffffffffffffffff161161047f57604051636ea6656560e11b815260040160405180910390fd5b61048e873388888888886107bd565b905060008082815260208190526040902060050154600160401b900460ff1660038111156104be576104be610a44565b146104dc5760405163748d150960e01b815260040160405180910390fd5b604051806101200160405280336001600160a01b03168152602001876001600160a01b03168152602001866001600160a01b031681526020018581526020018481526020018367ffffffffffffffff1681526020016001600381111561054457610544610a44565b81526000602080830182905260409283018b905284825281815290829020835181546001600160a01b039182166001600160a01b031991821617835592850151600183018054918316918516919091179055928401516002820180549190941692169190911790915560608201516003808301919091556080830151600483015560a083015160058301805467ffffffffffffffff90921667ffffffffffffffff1983168117825560c086015193919268ffffffffffffffffff19161790600160401b90849081111561061957610619610a44565b021790555060e0820151600682015561010090910151600790910155604080513381526001600160a01b0387811660208301529181018690526060810185905267ffffffffffffffff8416608082015290871690889083907f104157a39696517dddc95708f73b2330b343f9a036422c10529d947c9bfee9cd9060a00160405180910390a46106a9853386610916565b9695505050505050565b6040805161012081018252600080825260208201819052918101829052606081018290526080810182905260a0810182905260c0810182905260e081018290526101008101919091526000828152602081815260409182902082516101208101845281546001600160a01b0390811682526001830154811693820193909352600282015490921692820192909252600380830154606083015260048301546080830152600583015467ffffffffffffffff811660a084015291929160c0840191600160401b90910460ff169081111561078e5761078e610a44565b600381111561079f5761079f610a44565b81526006820154602082015260079091015460409091015292915050565b604080516020808201999099526001600160a01b0397881681830152958716606087015293909516608085015260a084019190915260c083015267ffffffffffffffff90921660e08083019190915282518083039091018152610100909101909152805191012090565b6040516001600160a01b03838116602483015260448201839052600091829186169060640160408051601f198184030181529181526020820180516001600160e01b031663a9059cbb60e01b179052516108819190610b7b565b6000604051808303816000865af19150503d80600081146108be576040519150601f19603f3d011682016040523d82523d6000602084013e6108c3565b606091505b50915091508115806108f157508051158015906108f15750808060200190518101906108ef9190610baa565b155b1561090f5760405163022e258160e11b815260040160405180910390fd5b5050505050565b6040516001600160a01b03838116602483015230604483015260648201839052600091829186169060840160408051601f198184030181529181526020820180516001600160e01b03166323b872dd60e01b179052516108819190610b7b565b60006020828403121561098857600080fd5b5035919050565b600080604083850312156109a257600080fd5b50508035926020909101359150565b80356001600160a01b03811681146109c857600080fd5b919050565b803567ffffffffffffffff811681146109c857600080fd5b60008060008060008060c087890312156109fe57600080fd5b86359550610a0e602088016109b1565b9450610a1c604088016109b1565b93506060870135925060808701359150610a3860a088016109cd565b90509295509295509295565b634e487b7160e01b600052602160045260246000fd5b60048110610a7857634e487b7160e01b600052602160045260246000fd5b9052565b81516001600160a01b0390811682526020808401518216908301526040808401519182169083015261012082019050606083015160608301526080830151608083015260a0830151610ada60a084018267ffffffffffffffff169052565b5060c0830151610aed60c0840182610a5a565b5060e083015160e083015261010083015161010083015292915050565b600080600080600080600060e0888a031215610b2557600080fd5b87359650610b35602089016109b1565b9550610b43604089016109b1565b9450610b51606089016109b1565b93506080880135925060a08801359150610b6d60c089016109cd565b905092959891949750929550565b6000825160005b81811015610b9c5760208186018101518583015201610b82565b506000920191825250919050565b600060208284031215610bbc57600080fd5b81518015158114610bcc57600080fd5b939250505056fea264697066735822122077e61bccf799e03c637991f95a9ad6d81ccae43e5c334f17867f1238a1839f6e64736f6c63430008240033" as const;

/** Recorded so a deployment can be reproduced and verified byte for byte. */
export const PAYMENT_HTLC_COMPILER = {
  version: "0.8.36+commit.8a079791.Emscripten.clang",
  evmVersion: "paris",
  optimizer: { enabled: true, runs: 200 },
} as const;
