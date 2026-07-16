'use strict';

const express = require('express');
const taskController = require('../controllers/taskController');
const taskFlowController = require('../controllers/taskFlowController');
const {
  authenticateContext,
  requireBusinessContext,
  requireModuleDataScope,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(
  authenticateContext,
  requireBusinessContext,
  businessWriteGuard,
  requireModuleDataScope('task')
);

const taskView = requirePermission('task.view');
const taskCreate = requirePermission('task.create');
const taskEdit = requirePermission('task.edit');
const taskAssign = requirePermission('task.assign');
const taskReview = requirePermission('task.review');
const taskExport = requirePermission('task.export');

function requireAssignmentPermissionWhenPresent(req, res, next) {
  const assignmentFields = ['executor', 'mainExecutor', 'ccUsers', 'subTasks'];
  if (assignmentFields.some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
    return taskAssign(req, res, next);
  }
  return next();
}

function rejectLegacyMultipart(req, res, next) {
  if (req.is('multipart/form-data')) {
    return res.status(415).json({
      message: 'Multipart task attachments are disabled; upload files through /api/files first',
      code: 'LEGACY_MULTIPART_DISABLED'
    });
  }
  return next();
}

// Static routes must remain before /:id.
router.get('/export', taskExport, taskController.batchExportTasks);
router.get('/my-tasks', taskView, taskController.getMyTasks);

router.post(
  '/',
  requireTeamContext,
  taskCreate,
  taskAssign,
  rejectLegacyMultipart,
  taskController.createTask
);
router.get('/', taskView, taskController.getTasks);

router.get('/:id', taskView, taskController.getTaskById);
router.put(
  '/:id',
  requireTeamContext,
  taskEdit,
  rejectLegacyMultipart,
  requireAssignmentPermissionWhenPresent,
  taskController.updateTask
);
router.delete('/:id', requireTeamContext, taskEdit, taskController.deleteTask);

// These route-level guards establish the authorization boundary. The flow
// controllers also enforce resource-level task/team filters.
router.post('/:id/complete', requireTeamContext, taskEdit, taskFlowController.completeTask);
router.put('/:id/complete', requireTeamContext, taskEdit, taskFlowController.updateCompletion);
router.post('/:id/review', requireTeamContext, taskReview, taskFlowController.reviewTask);
router.post('/:id/confirm', requireTeamContext, taskReview, taskFlowController.confirmTask);
router.get('/:id/reviews', taskView, taskFlowController.getTaskReviews);

module.exports = router;
