
import { ethers } from "ethers";

// Configuration
const RPC_URL = "https://rpc.flashbots.net";
// const RPC_URL = "https://eth.llamarpc.com";
const VEOLAS_ADDRESS = "0x7e01A500805f8A52Fad229b3015AD130A332B7b3";
const VOTE_WEIGHTING_ADDRESS = "0x95418b46d5566d3d1ea62c12aea91227e566c5c1";

const VEOLAS_ABI = [
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "event Deposit(address indexed provider, uint256 value, uint256 locktime, int128 type, uint256 ts)",
    "event Withdraw(address indexed provider, uint256 value, uint256 ts)"
];

const VOTE_WEIGHTING_ABI = [
    "function getWeightsSum() view returns (uint256)"
];

// Semaphore for concurrency control
class Semaphore {
    private tasks: (() => Promise<void>)[] = [];
    private activeCount = 0;

    constructor(private maxConcurrency: number) { }

    async acquire(): Promise<void> {
        if (this.activeCount < this.maxConcurrency) {
            this.activeCount++;
            return;
        }
        return new Promise<void>(resolve => {
            this.tasks.push(async () => {
                this.activeCount++;
                resolve();
            });
        });
    }

    release(): void {
        this.activeCount--;
        if (this.tasks.length > 0) {
            const next = this.tasks.shift();
            if (next) next();
        }
    }
}

async function main() {
    console.log("Connecting to RPC...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const veOLAS = new ethers.Contract(VEOLAS_ADDRESS, VEOLAS_ABI, provider);
    const voteWeighting = new ethers.Contract(VOTE_WEIGHTING_ADDRESS, VOTE_WEIGHTING_ABI, provider);

    // 1. Get Global Totals
    console.log("Fetching global totals...");
    const [globalTotalSupply, votedTotalWeight, currentBlock] = await Promise.all([
        veOLAS.totalSupply(),
        voteWeighting.getWeightsSum(),
        provider.getBlockNumber()
    ]);

    const globalTotalStr = ethers.formatEther(globalTotalSupply);
    const votedTotalStr = ethers.formatEther(votedTotalWeight);

    console.log(`\n--- Global Metrics ---`);
    console.log(`Global veOLAS Supply (Locked Power): ${globalTotalStr}`);
    console.log(`Total Voted veOLAS (In VoteWeighting): ${votedTotalStr}`);

    const participationRate = (Number(votedTotalWeight) * 100) / Number(globalTotalSupply);
    console.log(`Participation Rate: ${participationRate.toFixed(2)}%`);

    // 2. Analyze Holders
    console.log(`\nFetching holder logs from block 17600000 to ${currentBlock}...`);

    const START_BLOCK = 17600000;
    const CHUNK_SIZE = 999; // Llama limit is 1k strict, so 999 is safe
    const CONCURRENCY = 15;

    const filter = veOLAS.filters.Deposit();
    const chunks: { start: number, end: number }[] = [];

    for (let i = START_BLOCK; i <= currentBlock; i += CHUNK_SIZE) {
        chunks.push({ start: i, end: Math.min(i + CHUNK_SIZE - 1, currentBlock) });
    }

    console.log(`Total chunks: ${chunks.length}`);

    const semaphore = new Semaphore(CONCURRENCY);
    const uniqueHolders = new Set<string>();
    let completed = 0;

    const fetchChunk = async (chunk: { start: number, end: number }) => {
        await semaphore.acquire();
        try {
            const logs = await veOLAS.queryFilter(filter, chunk.start, chunk.end);
            logs.forEach(log => {
                const parsed = veOLAS.interface.parseLog({ topics: log.topics.slice(), data: log.data });
                if (parsed) uniqueHolders.add(parsed.args.provider);
            });
        } catch (e: any) {
            console.error(`Error fetching chunk ${chunk.start}-${chunk.end}: ${e.message}`);
            // Retry once?
            try {
                const logs = await veOLAS.queryFilter(filter, chunk.start, chunk.end);
                logs.forEach(log => {
                    const parsed = veOLAS.interface.parseLog({ topics: log.topics.slice(), data: log.data });
                    if (parsed) uniqueHolders.add(parsed.args.provider);
                });
            } catch (retryE) {
                console.error(`Failed retry chunk ${chunk.start}-${chunk.end}`);
            }
        } finally {
            semaphore.release();
            completed++;
            if (completed % 20 === 0 || completed === chunks.length) {
                process.stdout.write(`\rProgress: ${completed}/${chunks.length} chunks (${uniqueHolders.size} holders found)`);
            }
        }
    };

    await Promise.all(chunks.map(fetchChunk));
    console.log("\nDone fetching logs.");

    console.log(`Found ${uniqueHolders.size} unique addresses that have deposited.`);

    console.log("Fetching current balances...");
    const holders: { address: string, balance: bigint }[] = [];
    const holdersList = Array.from(uniqueHolders);

    const BALANCE_CONCURRENCY = 20;
    const balSemaphore = new Semaphore(BALANCE_CONCURRENCY);
    let balCompleted = 0;

    const fetchBalance = async (address: string) => {
        await balSemaphore.acquire();
        try {
            const balance = await veOLAS.balanceOf(address);
            if (balance > 0n) {
                holders.push({ address, balance });
            }
        } catch (e) {
            console.error(`Error fetching balance for ${address}`);
        } finally {
            balSemaphore.release();
            balCompleted++;
            if (balCompleted % 50 === 0) {
                process.stdout.write(`\rBalances: ${balCompleted}/${holdersList.length}`);
            }
        }
    };

    await Promise.all(holdersList.map(fetchBalance));
    process.stdout.write(`\rBalances: ${holdersList.length}/${holdersList.length}\n`);

    // Sort by balance
    holders.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

    console.log(`\nActive Holders (balance > 0): ${holders.length}`);

    // Proportions
    console.log("\n--- Distribution ---");
    const buckets = {
        "> 1M veOLAS": 0,
        "100k - 1M": 0,
        "10k - 100k": 0,
        "1k - 10k": 0,
        "< 1k": 0
    };

    for (let i = 0; i < holders.length; i++) {
        const balEth = parseFloat(ethers.formatEther(holders[i].balance));

        if (balEth >= 1_000_000) buckets["> 1M veOLAS"]++;
        else if (balEth >= 100_000) buckets["100k - 1M"]++;
        else if (balEth >= 10_000) buckets["10k - 100k"]++;
        else if (balEth >= 1_000) buckets["1k - 10k"]++;
        else buckets["< 1k"]++;

        // Top 10 holders print
        if (i < 10) {
            const pct = ((balEth / Number(globalTotalStr)) * 100).toFixed(2);
            console.log(`#${i + 1}: ${holders[i].address} - ${balEth.toFixed(2)} (${pct}%)`);
        }
    }

    console.log("\n--- Buckets ---");
    for (const [bucket, count] of Object.entries(buckets)) {
        console.log(`${bucket}: ${count} holders`);
    }
}

main().catch(console.error);
