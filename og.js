import { ethers } from 'ethers';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs'; // Menggunakan fs/promises untuk operasi file
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import dotenv from 'dotenv';

// --- Inisialisasi Awal ---
dotenv.config();

// Logger (tidak berubah)
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
  banner: () => console.log(`${colors.cyan}--- 0G Full-Automatic Uploader (v3) ---${colors.reset}\n`),
};

// --- Memuat Konfigurasi dari .env ---
const {
    PRIVATE_KEY,
    RPC_URL,
    INDEXER_URL,
    UPLOADS_TO_RUN,
    DELAY_MS,
    EXPLORER_URL
} = process.env;

// Validasi konfigurasi
if (!PRIVATE_KEY || !RPC_URL || !INDEXER_URL) {
    logger.critical("Pastikan PRIVATE_KEY, RPC_URL, dan INDEXER_URL ada di file .env");
    process.exit(1);
}

const uploadsCount = parseInt(UPLOADS_TO_RUN, 10) || 1;
const delayMilliseconds = parseInt(DELAY_MS, 10) || 5000;

// --- Setup Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const indexer = new Indexer(INDEXER_URL);

// Membuat direktori untuk file sementara jika belum ada
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.join(__dirname, 'generated-files');
if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR);
}

// --- Fungsi-fungsi Utama ---

function createAxiosInstance() {
    return axios.create({
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        }
    });
}

async function fetchRandomImage() {
    logger.loading('Fetching random image...');
    try {
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get('https://picsum.photos/800/600', {
            responseType: 'arraybuffer',
            maxRedirects: 5
        });
        logger.info('Image fetched successfully.');
        return response.data;
    } catch (error) {
        logger.error(`Error fetching image: ${error.message}`);
        throw error;
    }
}

/**
 * Fungsi ini sekarang menerima FILE PATH, bukan buffer.
 */
async function uploadFileWithSDK(filePath) {
    logger.loading(`Uploading file from path: ${filePath}`);

    // 1. Buat instance ZgFile dari file path. Ini adalah perubahan kunci.
    const file = new ZgFile(filePath);

    // 2. Panggil fungsi `upload` SESUAI DOKUMENTASI
    const [tx, err] = await indexer.upload(file, RPC_URL, wallet);

    // 3. Cek jika ada error
    if (err) {
        throw new Error(`SDK returned an error: ${err.message || err}`);
    }

    // 4. Proses transaksi
    const txLink = `${EXPLORER_URL}${tx.hash}`;
    logger.info(`Transaction sent: ${tx.hash}`);
    logger.info(`Explorer: ${txLink}`);
    
    logger.loading('Waiting for confirmation...');
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
        throw new Error(`Transaction failed with status ${receipt.status}`);
    }

    logger.info(`Transaction confirmed in block ${receipt.blockNumber}`);
    logger.info(`File uploaded successfully! Root hash: ${file.root}`);
    return receipt;
}


async function main() {
    logger.banner();
    try {
        // Cek koneksi dan saldo wallet
        logger.loading(`Checking connection to ${RPC_URL}...`);
        const network = await provider.getNetwork();
        logger.info(`Connected to network: chainId ${network.chainId}`);
        logger.loading(`Checking balance for wallet: ${wallet.address}`);
        const balance = await provider.getBalance(wallet.address);
        logger.info(`Wallet balance: ${ethers.formatEther(balance)} OG`);
        
        logger.section(`Starting ${uploadsCount} upload(s) for wallet ${wallet.address}`);

        let successful = 0;
        let failed = 0;

        for (let i = 1; i <= uploadsCount; i++) {
            logger.process(`Upload ${i}/${uploadsCount}`);
            let tempFilePath = '';
            try {
                // Buat nama file sementara yang unik
                const imageBuffer = await fetchRandomImage();
                const tempFileName = `${crypto.randomBytes(16).toString('hex')}.jpg`;
                tempFilePath = path.join(GENERATED_DIR, tempFileName);

                // Tulis buffer ke file sementara
                logger.loading(`Saving to temporary file: ${tempFilePath}`);
                await fs.writeFile(tempFilePath, imageBuffer);

                // Kirim path file ke fungsi upload
                await uploadFileWithSDK(tempFilePath);
                
                successful++;
                logger.info(`Upload ${i} completed successfully.`);

            } catch (error) {
                failed++;
                logger.error(`Upload ${i} failed: ${error.message}`);
            } finally {
                // Pastikan untuk selalu menghapus file sementara
                if (tempFilePath) {
                    try {
                        await fs.unlink(tempFilePath);
                        logger.info(`Temporary file ${tempFilePath} deleted.`);
                    } catch (cleanupError) {
                        logger.warn(`Failed to delete temporary file: ${cleanupError.message}`);
                    }
                }
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
