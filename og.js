import { ethers } from 'ethers';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import dotenv from 'dotenv';

// --- Inisialisasi Awal ---
dotenv.config();

// Logger
const colors = {
  reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", white: "\x1b[37m",
};
const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  process: (msg) => console.log(`\n${colors.white}[➤] ${msg}${colors.reset}`),
  critical: (msg) => console.log(`${colors.red}[❌] ${msg}${colors.reset}`),
  section: (msg) => console.log(`\n${colors.cyan}${'='.repeat(50)}\n${msg}\n${'='.repeat(50)}${colors.reset}\n`),
  banner: () => console.log(`${colors.cyan}--- 0G Uploader (Manual Fallback v6) ---${colors.reset}\n`),
};

// --- Memuat Konfigurasi dari .env ---
const {
    PRIVATE_KEY, RPC_URL, INDEXER_URL, CONTRACT_ADDRESS,
    UPLOADS_TO_RUN, DELAY_MS, EXPLORER_URL, STORAGE_FEE_IN_ETHER
} = process.env;

if (!PRIVATE_KEY || !RPC_URL || !INDEXER_URL || !CONTRACT_ADDRESS || !STORAGE_FEE_IN_ETHER) {
    logger.critical("Pastikan semua variabel (termasuk CONTRACT_ADDRESS & STORAGE_FEE_IN_ETHER) ada di file .env");
    process.exit(1);
}

const uploadsCount = parseInt(UPLOADS_TO_RUN, 10) || 1;
const delayMilliseconds = parseInt(DELAY_MS, 10) || 5000;
const storageFee = ethers.parseEther(STORAGE_FEE_IN_ETHER); // Konversi biaya ke wei

// --- Setup Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Direktori sementara
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.join(__dirname, 'generated-files');

// --- Fungsi-fungsi Utama ---
async function ensureDirectoryExists(dirPath) {
    try { await fs.access(dirPath); } catch (error) {
        if (error.code === 'ENOENT') { await fs.mkdir(dirPath); } else { throw error; }
    }
}

async function fetchRandomImage() {
    logger.loading('Fetching random image...');
    try {
        const response = await axios.get('https://picsum.photos/800/600', {
            responseType: 'arraybuffer', maxRedirects: 5
        });
        logger.info('Image fetched successfully.');
        return response.data;
    } catch (error) {
        logger.error(`Error fetching image: ${error.message}`);
        throw error;
    }
}

/**
 * **PERUBAHAN DI SINI:** Menambahkan `value` ke dalam transaksi
 */
async function uploadFileManually(imageBuffer) {
    logger.loading('Preparing file for manual upload...');
    const root = '0x' + crypto.createHash('sha256').update(imageBuffer).digest('hex');
    const size = imageBuffer.length;

    logger.loading(`Uploading file segment for root ${root}...`);
    await axios.post(`${INDEXER_URL}/file/segment`, {
        root: root,
        index: 0,
        data: Buffer.from(imageBuffer).toString('base64'),
        proof: { siblings: [root], path: [] }
    }, { headers: { 'content-type': 'application/json' } });
    logger.info('File segment uploaded to indexer.');

    const iface = new ethers.Interface([`function store(bytes32 _root, uint64 _dataSize)`]);
    const data = iface.encodeFunctionData("store", [root, BigInt(size)]);
    
    logger.loading('Estimating gas and sending transaction with storage fee...');
    const tx = await wallet.sendTransaction({
        to: CONTRACT_ADDRESS,
        data: data,
        value: storageFee // **INI PERUBAHANNYA**
    });

    const txLink = `${EXPLORER_URL}${tx.hash}`;
    logger.info(`Transaction sent: ${tx.hash}`);
    logger.info(`Explorer: ${txLink}`);
    
    logger.loading('Waiting for confirmation...');
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
        throw new Error(`Transaction failed with status ${receipt.status}`);
    }

    logger.info(`Transaction confirmed in block ${receipt.blockNumber}`);
    logger.info(`File uploaded successfully! Root hash: ${root}`);
    return receipt;
}

async function main() {
    logger.banner();
    try {
        await ensureDirectoryExists(GENERATED_DIR);
        logger.loading(`Checking connection to ${RPC_URL}...`);
        const network = await provider.getNetwork();
        logger.info(`Connected to network: chainId ${network.chainId}`);
        logger.loading(`Checking balance for wallet: ${wallet.address}`);
        const balance = await provider.getBalance(wallet.address);
        logger.info(`Wallet balance: ${ethers.formatEther(balance)} OG`);
        
        if (balance < storageFee) {
            logger.critical(`Saldo tidak cukup (${ethers.formatEther(balance)} OG). Dibutuhkan > ${ethers.formatEther(storageFee)} OG untuk biaya.`);
            return;
        }

        logger.section(`Starting ${uploadsCount} upload(s) for wallet ${wallet.address}`);

        let successful = 0;
        let failed = 0;

        for (let i = 1; i <= uploadsCount; i++) {
            logger.process(`Upload ${i}/${uploadsCount}`);
            try {
                const imageBuffer = await fetchRandomImage();
                await uploadFileManually(imageBuffer);
                successful++;
                logger.info(`Upload ${i} completed successfully.`);
            } catch (error) {
                failed++;
                logger.error(`Upload ${i} failed: ${error.message}`);
            }

            if (i < uploadsCount) {
                logger.loading(`Waiting for ${delayMilliseconds / 1000}s before next upload...`);
                await new Promise(resolve => setTimeout(resolve, delayMilliseconds));
            }
        }

        logger.section('Upload Summary');
        logger.info(`Total tasks: ${uploadsCount}`);
        logger.info(`Successful: ${successful}`);
        logger.error(`Failed: ${failed}`);

    } catch (error) {
        logger.critical(`A critical error occurred: ${error.message}`);
        process.exit(1);
    }
}

main();
