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
const {
  requireTaskPermissionOrLeadershipCandidate
} = require('../middlewares/taskLeadershipAuthorization');

const router = express.Router();

router.use(
  authenticateContext,
  requireBusinessContext,
  businessWriteGuard,
  requireModuleDataScope('task')
);

const taskView = requirePermission('task.view');
const taskExport = requirePermission('task.export');
const taskViewOrLeader = requireTaskPermissionOrLeadershipCandidate('task.view');
const taskCreateOrLeader = requireTaskPermissionOrLeadershipCandidate('task.create');
const taskEditOrLeader = requireTaskPermissionOrLeadershipCandidate('task.edit');
const taskAssignOrLeader = requireTaskPermissionOrLeadershipCandidate('task.assign');
const taskReviewOrLeader = requireTaskPermissionOrLeadershipCandidate('task.review');

function requireAssignmentPermissionWhenPresent(req, res, next) {
  const assignmentFields = ['executor', 'mainExecutor', 'ccUsers', 'subTasks'];
  if (assignmentFields.some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
    return taskAssignOrLeader(req, res, next);
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
router.get('/assignable-users', taskAssignOrLeader, taskController.getAssignableUsers);
router.get('/my-tasks', taskView, taskController.getMyTasks);

router.post(
  '/',
  requireTeamContext,
  taskCreateOrLeader,
  taskAssignOrLeader,
  rejectLegacyMultipart,
  taskController.createTask
);
router.get('/', taskViewOrLeader, taskController.getTasks);

router.get('/:id', taskViewOrLeader, taskController.getTaskById);
router.put(
  '/:id',
  requireTeamContext,
  taskEditOrLeader,
  rejectLegacyMultipart,
  requireAssignmentPermissionWhenPresent,
  taskController.updateTask
);
router.delete('/:id', requireTeamContext, taskEditOrLeader, taskController.deleteTask);

// These route-level guards establish the authorization boundary. The flow
// controllers also enforce resource-level task/team filters.
router.post('/:id/complete', requireTeamContext, taskView, taskFlowController.completeTask);
router.put('/:id/complete', requireTeamContext, taskView, taskFlowController.updateCompletion);
router.post('/:id/review', requireTeamContext, taskReviewOrLeader, taskFlowController.reviewTask);
router.post('/:id/confirm', requireTeamContext, taskViewOrLeader, taskFlowController.confirmTask);
router.get('/:id/reviews', taskViewOrLeader, taskFlowController.getTaskReviews);

module.exports = router;
