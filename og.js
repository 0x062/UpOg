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
  success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  process: (msg) => console.log(`\n${colors.white}[➤] ${msg}${colors.reset}`),
  critical: (msg) => console.log(`${colors.red}[❌] ${msg}${colors.reset}`),
  section: (msg) => console.log(`\n${colors.cyan}${'='.repeat(50)}\n${msg}\n${'='.repeat(50)}${colors.reset}\n`),
  banner: () => console.log(`${colors.cyan}--- 0G Uploader (The Real Final Version) ---${colors.reset}\n`),
};

// --- Memuat Konfigurasi dari .env ---
const {
    PRIVATE_KEY, RPC_URL, INDEXER_URL, CONTRACT_ADDRESS,
    UPLOADS_TO_RUN, DELAY_MS, EXPLORER_URL
} = process.env;

if (!PRIVATE_KEY || !RPC_URL || !INDEXER_URL || !CONTRACT_ADDRESS) {
    logger.critical("Pastikan semua variabel di file .env sudah benar.");
    process.exit(1);
}

const uploadsCount = parseInt(UPLOADS_TO_RUN, 10) || 1;
const delayMilliseconds = parseInt(DELAY_MS, 10) || 5000;

// --- Setup Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// --- Fungsi-fungsi Utama ---
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
 * Logika disesuaikan dengan penanganan gas eksplisit dari script Anda.
 */
async function uploadAndSubmitTransaction(imageBuffer) {
    // 1. Upload file ke storage node
    const rootForIndexer = '0x' + crypto.createHash('sha256').update(imageBuffer).digest('hex');
    logger.loading(`Uploading file segment for root ${rootForIndexer}...`);
    
    await axios.post(`${INDEXER_URL}/file/segment`, {
        root: rootForIndexer,
        index: 0,
        data: Buffer.from(imageBuffer).toString('base64'),
        proof: { siblings: [rootForIndexer], path: [] }
    }, { headers: { 'content-type': 'application/json' } });
    logger.info('File segment uploaded to indexer.');

    // 2. Membuat calldata secara manual
    const METHOD_ID = '0xef3e12dc';
    const contentHash = crypto.randomBytes(32);

    const data = ethers.concat([
        Buffer.from(METHOD_ID.slice(2), 'hex'),
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000020', 'hex'),
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000014', 'hex'),
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000060', 'hex'),
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000080', 'hex'),
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
        contentHash,
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
    ]);

    // 3. Menyiapkan parameter transaksi dengan gas eksplisit
    const value = ethers.parseEther('0.000839233398436224');
    const gasPrice = ethers.parseUnits('1.1', 'gwei'); // Menggunakan gas price yang sedikit lebih tinggi untuk keamanan
    let gasLimit;

    logger.loading('Estimating gas...');
    try {
        const gasEstimate = await provider.estimateGas({
            to: CONTRACT_ADDRESS,
            data,
            from: wallet.address,
            value
        });
        gasLimit = (BigInt(gasEstimate) * 15n) / 10n; // Tambah buffer 50%
        logger.info(`Gas limit estimated: ${gasLimit}`);
    } catch (error) {
        gasLimit = 300000n; // Fallback jika estimasi gagal
        logger.warn(`Gas estimation failed, using default: ${gasLimit}. Error: ${error.message}`);
    }

    // 4. Mengirim transaksi
    logger.loading('Sending transaction with explicit gas parameters...');
    const txParams = {
        to: CONTRACT_ADDRESS,
        data,
        value,
        gasPrice,
        gasLimit
    };
    
    const tx = await wallet.sendTransaction(txParams);
    const txLink = `${EXPLORER_URL}${tx.hash}`;
    logger.info(`Transaction sent: ${tx.hash}`);
    logger.info(`Explorer: ${txLink}`);
    
    logger.loading('Waiting for confirmation...');
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
        throw new Error(`Transaction failed with status 0`);
    }

    logger.success(`Transaction confirmed in block ${receipt.blockNumber}`);
    logger.success(`Submission successful!`);
    return receipt;
}

async function main() {
    logger.banner();
    try {
        logger.loading(`Checking balance for wallet: ${wallet.address}`);
        const balance = await provider.getBalance(wallet.address);
        logger.info(`Wallet balance: ${ethers.formatEther(balance)} OG`);

        logger.section(`Starting ${uploadsCount} upload(s) for wallet ${wallet.address}`);
        let successful = 0;
        let failed = 0;

        for (let i = 1; i <= uploadsCount; i++) {
            logger.process(`Upload ${i}/${uploadsCount}`);
            try {
                const imageBuffer = await fetchRandomImage();
                await uploadAndSubmitTransaction(imageBuffer);
                successful++;
                logger.success(`Upload ${i} completed successfully.`);
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
        logger.success(`Successful: ${successful}`);
        if(failed > 0) logger.error(`Failed: ${failed}`);

    } catch (error) {
        logger.critical(`A critical error occurred: ${error.message}`);
        process.exit(1);
    }
}

main();
