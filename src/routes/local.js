import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import * as ctrl from '../controllers/localController.js';

const router = express.Router();

// All local operations require admin (localhost yönetim)
router.get('/local/m3u', authenticateToken, ctrl.getLocalM3u);
router.get('/local/m3u/temp', authenticateToken, ctrl.getTempM3u);
router.post('/local/m3u/prepare', authenticateToken, ctrl.prepareLocalM3u);
router.post('/local/m3u/commit', authenticateToken, ctrl.commitLocalM3u);
router.post('/local/m3u/create-desktop-txt', authenticateToken, ctrl.createDesktopM3u);

router.get('/local/apk/version', authenticateToken, ctrl.getVersion);
router.put('/local/apk/version', authenticateToken, ctrl.updateVersion);
router.post('/local/apk/rollback', authenticateToken, ctrl.rollbackVersion);
router.get('/local/apk/history', authenticateToken, ctrl.getHistory);
router.post('/local/apk/build', authenticateToken, ctrl.triggerBuild);
router.post('/local/apk/stop', authenticateToken, ctrl.stopBuildCtrl);

export default router;
