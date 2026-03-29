import "hardhat/types/runtime";

declare module "hardhat/types/runtime" {
  interface HardhatRuntimeEnvironment {
    deployMetadata: {
      pushMetadataToIPFSWithBytecode(bytecode: string): Promise<string>;
    };
  }
}
