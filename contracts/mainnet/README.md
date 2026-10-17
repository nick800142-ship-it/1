# Base 主網正式版合約（尚未部署）

| 合約 | 地址（CREATE2 預先固定） | owner | 備註 |
| --- | --- | --- | --- |
| JC | `0xeE12e3829B86265795108E99F161757BBE89199C` | Safe | 18 decimals、初始供給 0 |
| AE | `0x647F8bC9CaE2cE3bC6f11Ebe50C34A133706629F` | Safe | 18 decimals、初始供給 0 |
| RWA Factory | `0x402DD7360B6efeDbAB580c36Ce6FfE697E4a88d9` | Safe | 無 operator |
| P2P 託管 | `0xE53717C6812C06420a36A8e1018d1bb5eDd585a9` | Safe | operator＝熱錢包、手續費收款＝Safe、1% / 1 JC |

- Safe `0x75653E53DE9b7b390e803295DdB4Afc461b55A9b`（2/3）、熱錢包 `0x9FB5c5315Dc4329BFd04c17AB099a2e01327377F`、USDT `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`（6 decimals）。
- 地址由 CREATE2 部署器 `0x4e59b44847b379578588920cA78FbF26c0B4956C` + 固定 salt + 固定 init code 決定，與誰送出交易無關；**改任何一個字元的原始碼、換 solc 版本或改建構參數，地址都會變**。編譯設定：solc 0.8.37、optimizer 200、viaIR、shanghai、bytecodeHash none、OpenZeppelin 5.6.1。

## 權限
- JC / AE：`mint(amount)` 只有 Safe 能呼叫，且只鑄給 Safe；`burn(amount)` 任何人只燒自己的餘額；無轉帳限制、無暫停、無費用、無上限、無強制收回；Ownable2Step、停用 renounce。
- RWA Factory：只有 Safe 能建立代幣（全額鑄給 Safe）、銷毀 Safe 庫存、下架收回（只收回 Safe）；`migrateToken` 可把份額代幣管理權交給新工廠，新工廠用 `importToken` 接手。
- P2P 託管：費率／收款／operator／unpause 限 Safe；熱錢包只能撮合、forceCancel（只退回原掛單人）、pause。

## 指令
```
node scripts/mainnet/build-contracts.mjs --check   # 原始碼與凍結地址一致
node scripts/mainnet/test-contracts.mjs            # 本地模擬主網，23 項權限測試
node scripts/mainnet/verify-config.mjs             # 設定一致 + 唯讀查主網狀態
node scripts/mainnet/deploy.mjs                    # 乾跑；加 --broadcast 才上鏈
```
