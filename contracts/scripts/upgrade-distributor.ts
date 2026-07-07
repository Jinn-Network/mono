import { network } from "hardhat";
import { Wallet, JsonRpcProvider } from "ethers";

async function main() {
  const { ethers } = await network.connect();
  const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, new JsonRpcProvider("https://sepolia.base.org"));
  
  const Factory = await ethers.getContractFactory("ExternalStakingDistributor", deployer);
  console.log("Deploying new impl...");
  const impl = await Factory.deploy(
    "0xAB9a01cd4A379e36006ec6df2960CF39EF79df63",
    "0x5BA58970c2Ae16Cf6218783018100aF2dCcFc915",
    "0x20F7b9b55a88e3b2561fe83B076DE52916C7eaf0",
    "0x10100e74b7F706222F8A7C0be9FC7Ae1717Ad8B2",
    "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
    "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D",
    "0x21c52Be4F656435F97d0335B37e21B417c8b6DFa",
    { gasLimit: 5000000 }
  );
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("New impl:", implAddr);
  
  const proxy = Factory.attach("0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81");
  console.log("Upgrading proxy...");
  const tx = await (proxy as any).changeImplementation(implAddr, { gasLimit: 200000 });
  await tx.wait();
  console.log("Done! Proxy upgraded.");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
