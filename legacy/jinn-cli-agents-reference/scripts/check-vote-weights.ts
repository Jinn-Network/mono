
import { ethers } from "ethers";

// Configuration
const MAINNET_RPC = "https://eth.llamarpc.com"; // Public RPC
const VOTE_WEIGHTING_ADDRESS = "0x95418b46d5566d3d1ea62c12aea91227e566c5c1";
const USER_STAKING_CONTRACT = "0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139";
const CHAIN_ID = 8453; // Base

const ABI = [
    "function getWeightsSum() external view returns (uint256)",
    "function getNomineeWeight(bytes32 account, uint256 chainId) external view returns (uint256)",
    "function nomineeRelativeWeight(bytes32 account, uint256 chainId, uint256 time) external view returns (uint256 relativeWeight, uint256 totalSum)"
];

async function main() {
    console.log("Connecting to Mainnet...");
    const provider = new ethers.JsonRpcProvider(MAINNET_RPC);
    const contract = new ethers.Contract(VOTE_WEIGHTING_ADDRESS, ABI, provider);

    // Prepare nominee
    // nomineeHash = keccak256(abi.encode(Nominee(account, chainId)))
    // But getNomineeWeight takes (bytes32 account, uint256 chainId) directly.
    // The account must be bytes32 padded.
    const accountPadded = ethers.zeroPadValue(USER_STAKING_CONTRACT, 32);

    console.log(`Querying VoteWeighting at ${VOTE_WEIGHTING_ADDRESS}`);
    console.log(`Target: ${USER_STAKING_CONTRACT} (Padded: ${accountPadded})`);
    console.log(`Chain ID: ${CHAIN_ID}`);

    const timestamp = Math.floor(Date.now() / 1000);
    console.log(`Current timestamp: ${timestamp}`);

    try {
        const totalSum = await contract.getWeightsSum();
        console.log(`Total Weights Sum (from getWeightsSum): ${totalSum.toString()}`);

        const nomineeWeight = await contract.getNomineeWeight(accountPadded, CHAIN_ID);
        console.log(`Nominee Weight (from getNomineeWeight): ${nomineeWeight.toString()}`);

        // Also check relative weight for this week
        const [relWeight, relTotalSum] = await contract.nomineeRelativeWeight(accountPadded, CHAIN_ID, timestamp);
        console.log(`Nominee Relative Weight (normalized to 1e18): ${relWeight.toString()}`);
        console.log(`Total Sum (from relative call): ${relTotalSum.toString()}`);

        // Calculations
        const totalVeOLASInPlay = ethers.formatUnits(relTotalSum > 0n ? relTotalSum : totalSum, 18);
        const myWeight = ethers.formatUnits(nomineeWeight, 18); // Wait, bias is int128/uint256 but scale?
        // VeOLAS bias is usually 1e18 scale if the token is 1e18. OLAS is 1e18.

        console.log("\n--- Results ---");
        console.log(`Total veOLAS in Play: ${totalVeOLASInPlay}`);
        console.log(`Your Contract Vote Weight: ${myWeight}`);

        if (relTotalSum > 0n) {
            const percentage = (Number(nomineeWeight) * 100) / Number(relTotalSum);
            console.log(`Your Percentage share: ${percentage.toFixed(4)}%`);

            if (percentage < 0.5) {
                console.log(`WARNING: You are below the 0.5% threshold.`);
            } else {
                console.log(`SUCCESS: You are above the 0.5% threshold.`);
            }
        } else {
            console.log("Total sum is 0, possibly no checkpoint for this week yet.");
        }

    } catch (error) {
        console.error("Error fetching data:", error);
    }
}

main();
